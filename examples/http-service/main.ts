/**
 * HTTP Service Example
 *
 * Exposes an HTTP API that accepts POST requests with a desired sample rate,
 * loads the corresponding PCM audio file, processes it through the avatar
 * service, and returns the results as JSON.
 *
 * Endpoints:
 * - GET /healthz - Health check
 * - POST /generate - Generate animation from audio
 *
 * Required environment variables:
 * - AVATAR_API_KEY
 * - AVATAR_APP_ID
 * - AVATAR_CONSOLE_ENDPOINT
 * - AVATAR_INGRESS_ENDPOINT
 * - AVATAR_SESSION_AVATAR_ID
 * - AVATAR_USE_QUERY_AUTH (optional)
 * - PORT (optional, default: 8080)
 * - HOST (optional, default: 127.0.0.1)
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { newAvatarSession, SessionTokenError, AvatarSDKError } from "avatarkit-server";

const config = {
  apiKey: process.env.AVATAR_API_KEY || "",
  appId: process.env.AVATAR_APP_ID || "",
  consoleEndpoint: process.env.AVATAR_CONSOLE_ENDPOINT || "",
  ingressEndpoint: process.env.AVATAR_INGRESS_ENDPOINT || "",
  avatarId: process.env.AVATAR_SESSION_AVATAR_ID || "",
  useQueryAuth: process.env.AVATAR_USE_QUERY_AUTH === "true",
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "127.0.0.1",
};

const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes
const REQUEST_TIMEOUT_MS = 45000; // 45 seconds

// Audio asset discovery
interface AudioAsset {
  sampleRate: number;
  path: string;
}

function discoverAudioAssets(): Map<number, AudioAsset> {
  const assets = new Map<number, AudioAsset>();
  const dir = import.meta.dirname;

  const files = fs.readdirSync(dir);
  const pattern = /^audio_(\d+)\.pcm$/;

  for (const file of files) {
    const match = file.match(pattern);
    if (match) {
      const sampleRate = parseInt(match[1], 10);
      assets.set(sampleRate, {
        sampleRate,
        path: path.join(dir, file),
      });
    }
  }

  return assets;
}

// Animation collector
class Collector {
  frames: Uint8Array[] = [];
  done: boolean = false;
  error: Error | null = null;
  private resolveWait: (() => void) | null = null;

  transportFrame(data: Uint8Array, isLast: boolean): void {
    this.frames.push(data);
    if (isLast) {
      this.done = true;
      this.resolveWait?.();
    }
  }

  onError(err: Error): void {
    this.error = err;
    this.resolveWait?.();
  }

  onClose(): void {
    this.resolveWait?.();
  }

  async wait(timeoutMs: number): Promise<void> {
    if (this.done || this.error) return;

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout waiting for animation frames")), timeoutMs);
    });

    const waitPromise = new Promise<void>((resolve) => {
      this.resolveWait = resolve;
    });

    await Promise.race([waitPromise, timeoutPromise]);
  }
}

// CORS headers
function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// JSON response helpers
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

// Read request body
async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Handle /generate endpoint
async function handleGenerate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  audioAssets: Map<number, AudioAsset>
): Promise<void> {
  // Parse request body
  let sampleRate = 16000;
  try {
    const body = await readBody(req);
    if (body) {
      const parsed = JSON.parse(body);
      if (parsed.sample_rate) {
        sampleRate = parsed.sample_rate;
      }
    }
  } catch {
    sendError(res, 400, "invalid_request", "Invalid JSON body");
    return;
  }

  // Find audio asset
  const asset = audioAssets.get(sampleRate);
  if (!asset) {
    const available = Array.from(audioAssets.keys()).sort((a, b) => a - b);
    sendError(
      res,
      404,
      "audio_not_found",
      `No audio file for sample rate ${sampleRate}. Available: ${available.join(", ")}`
    );
    return;
  }

  // Load audio
  const audioData = fs.readFileSync(asset.path);

  // Create collector and session
  const collector = new Collector();
  const session = newAvatarSession({
    apiKey: config.apiKey,
    appId: config.appId,
    avatarId: config.avatarId,
    consoleEndpointUrl: config.consoleEndpoint,
    ingressEndpointUrl: config.ingressEndpoint,
    useQueryAuth: config.useQueryAuth,
    expireAt: new Date(Date.now() + SESSION_TTL_MS),
    sampleRate: sampleRate,
    transportFrames: (data, isLast) => collector.transportFrame(data, isLast),
    onError: (err) => collector.onError(err),
    onClose: () => collector.onClose(),
  });

  try {
    // Initialize and start
    await session.init();
    const connectionId = await session.start();

    // Send audio
    const reqId = await session.sendAudio(new Uint8Array(audioData), true);

    // Wait for frames
    await collector.wait(REQUEST_TIMEOUT_MS);

    if (collector.error) {
      throw collector.error;
    }

    // Build response
    const response = {
      sample_rate: sampleRate,
      audio_format: "pcm_s16le_mono",
      audio_base64: audioData.toString("base64"),
      connection_id: connectionId,
      req_id: reqId,
      animation_messages_base64: collector.frames.map((f) => Buffer.from(f).toString("base64")),
    };

    sendJson(res, 200, response);
  } catch (err) {
    if (err instanceof SessionTokenError) {
      sendError(res, 502, "session_token_error", err.message);
    } else if (err instanceof AvatarSDKError) {
      sendError(res, 502, err.code, err.message);
    } else {
      sendError(res, 500, "internal_error", String(err));
    }
  } finally {
    await session.close();
  }
}

// Main server
async function main(): Promise<void> {
  // Validate configuration
  if (
    !config.apiKey ||
    !config.appId ||
    !config.consoleEndpoint ||
    !config.ingressEndpoint ||
    !config.avatarId
  ) {
    console.error("Missing required environment variables");
    process.exit(1);
  }

  // Discover audio assets
  const audioAssets = discoverAudioAssets();
  console.log(`Discovered audio assets: ${Array.from(audioAssets.keys()).join(", ")} Hz`);

  if (audioAssets.size === 0) {
    console.warn("Warning: No audio files found. Add audio_<samplerate>.pcm files to this directory.");
  }

  // Create server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (url.pathname === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
    } else if (url.pathname === "/generate" && req.method === "POST") {
      await handleGenerate(req, res, audioAssets);
    } else {
      sendError(res, 404, "not_found", "Endpoint not found");
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`Server listening on http://${config.host}:${config.port}`);
    console.log("Endpoints:");
    console.log("  GET  /healthz  - Health check");
    console.log("  POST /generate - Generate animation from audio");
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
