/**
 * Single Audio Clip Example
 *
 * Demonstrates the basic workflow of connecting to an avatar service,
 * sending a single audio file, and receiving animation frames.
 *
 * Required environment variables:
 * - AVATAR_API_KEY
 * - AVATAR_APP_ID
 * - AVATAR_CONSOLE_ENDPOINT
 * - AVATAR_INGRESS_ENDPOINT
 * - AVATAR_SESSION_AVATAR_ID
 * - AVATAR_USE_QUERY_AUTH (optional, "true" for web-based auth)
 */

import * as fs from "fs";
import * as path from "path";
import { newAvatarSession, SessionTokenError, AvatarSDKError } from "avatarkit-server";

// Configuration from environment
const config = {
  apiKey: process.env.AVATAR_API_KEY || "",
  appId: process.env.AVATAR_APP_ID || "",
  consoleEndpoint: process.env.AVATAR_CONSOLE_ENDPOINT || "",
  ingressEndpoint: process.env.AVATAR_INGRESS_ENDPOINT || "",
  avatarId: process.env.AVATAR_SESSION_AVATAR_ID || "",
  useQueryAuth: process.env.AVATAR_USE_QUERY_AUTH === "true",
};

// Animation collector to gather frames asynchronously
class AnimationCollector {
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
    console.error("Session error:", err.message);
    this.resolveWait?.();
  }

  onClose(): void {
    console.log("Session closed");
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

async function main(): Promise<void> {
  // Validate configuration
  if (!config.apiKey || !config.appId || !config.consoleEndpoint || !config.ingressEndpoint || !config.avatarId) {
    console.error("Missing required environment variables");
    console.error("Required: AVATAR_API_KEY, AVATAR_APP_ID, AVATAR_CONSOLE_ENDPOINT, AVATAR_INGRESS_ENDPOINT, AVATAR_SESSION_AVATAR_ID");
    process.exit(1);
  }

  // Load audio file
  const audioPath = path.join(import.meta.dirname, "audio_16000.pcm");
  if (!fs.existsSync(audioPath)) {
    console.error(`Audio file not found: ${audioPath}`);
    console.error("Please provide an audio_16000.pcm file in the example directory");
    process.exit(1);
  }

  const audioData = fs.readFileSync(audioPath);
  console.log(`Loaded audio file: ${audioData.length} bytes`);

  // Create collector
  const collector = new AnimationCollector();

  // Create session
  const session = newAvatarSession({
    apiKey: config.apiKey,
    appId: config.appId,
    avatarId: config.avatarId,
    consoleEndpointUrl: config.consoleEndpoint,
    ingressEndpointUrl: config.ingressEndpoint,
    useQueryAuth: config.useQueryAuth,
    expireAt: new Date(Date.now() + 2 * 60 * 1000), // 2 minutes TTL
    sampleRate: 16000,
    transportFrames: (data, isLast) => collector.transportFrame(data, isLast),
    onError: (err) => collector.onError(err),
    onClose: () => collector.onClose(),
  });

  try {
    // Initialize session (get token)
    console.log("Initializing session...");
    await session.init();

    // Start WebSocket connection
    console.log("Starting WebSocket connection...");
    const connectionId = await session.start();
    console.log(`Connected: ${connectionId}`);

    // Send audio
    console.log("Sending audio...");
    const reqId = await session.sendAudio(new Uint8Array(audioData), true);
    console.log(`Sent audio, request ID: ${reqId}`);

    // Wait for animation frames
    console.log("Waiting for animation frames...");
    await collector.wait(45000); // 45 second timeout

    if (collector.error) {
      throw collector.error;
    }

    // Output results
    const result = {
      audio_preview: Array.from(audioData.slice(0, 100)),
      animation_count: collector.frames.length,
      animation_sizes: collector.frames.map((f) => f.length),
      connection_id: connectionId,
      req_id: reqId,
    };

    console.log("\nResult:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof SessionTokenError) {
      console.error("Session token error:", err.message);
    } else if (err instanceof AvatarSDKError) {
      console.error(`Avatar SDK error (${err.code}):`, err.message);
    } else {
      console.error("Error:", err);
    }
    process.exit(1);
  } finally {
    await session.close();
  }
}

main();
