/**
 * Connection Pool Example
 *
 * Demonstrates efficient resource management by maintaining a pool of
 * pre-initialized connections and processing multiple concurrent audio
 * requests over multiple rounds.
 *
 * Required environment variables:
 * - AVATAR_API_KEY
 * - AVATAR_APP_ID
 * - AVATAR_CONSOLE_ENDPOINT
 * - AVATAR_INGRESS_ENDPOINT
 * - AVATAR_SESSION_AVATAR_ID
 * - AVATAR_USE_QUERY_AUTH (optional)
 */

import * as fs from "fs";
import * as path from "path";
import { newAvatarSession, AvatarSession } from "avatarkit-server";

// Configuration
const POOL_SIZE = 100;
const CONCURRENT_REQUESTS = 5;
const NUM_ROUNDS = 10;
const ROUND_INTERVAL_MS = 30000; // 30 seconds
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REQUEST_TIMEOUT_MS = 45000; // 45 seconds

const config = {
  apiKey: process.env.AVATAR_API_KEY || "",
  appId: process.env.AVATAR_APP_ID || "",
  consoleEndpoint: process.env.AVATAR_CONSOLE_ENDPOINT || "",
  ingressEndpoint: process.env.AVATAR_INGRESS_ENDPOINT || "",
  avatarId: process.env.AVATAR_SESSION_AVATAR_ID || "",
  useQueryAuth: process.env.AVATAR_USE_QUERY_AUTH === "true",
};

// Animation collector with reset capability for reuse
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
    this.resolveWait?.();
  }

  onClose(): void {
    this.resolveWait?.();
  }

  reset(): void {
    this.frames = [];
    this.done = false;
    this.error = null;
    this.resolveWait = null;
  }

  async wait(timeoutMs: number): Promise<void> {
    if (this.done || this.error) return;

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    });

    const waitPromise = new Promise<void>((resolve) => {
      this.resolveWait = resolve;
    });

    await Promise.race([waitPromise, timeoutPromise]);
  }
}

// Pooled connection wrapper
interface PooledConnection {
  session: AvatarSession;
  collector: AnimationCollector;
  connectionId: string;
  createdAt: Date;
  requestCount: number;
}

// Connection pool
class AvatarConnectionPool {
  private available: PooledConnection[] = [];
  private allConnections: PooledConnection[] = [];

  async initialize(count: number): Promise<void> {
    console.log(`Initializing ${count} connections...`);
    const startTime = Date.now();

    const initPromises = Array.from({ length: count }, (_, i) => this.createConnection(i));
    const results = await Promise.allSettled(initPromises);

    let successCount = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        this.available.push(result.value);
        this.allConnections.push(result.value);
        successCount++;
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`Initialized ${successCount}/${count} connections in ${elapsed}ms`);
  }

  private async createConnection(index: number): Promise<PooledConnection | null> {
    const collector = new AnimationCollector();

    const session = newAvatarSession({
      apiKey: config.apiKey,
      appId: config.appId,
      avatarId: config.avatarId,
      consoleEndpointUrl: config.consoleEndpoint,
      ingressEndpointUrl: config.ingressEndpoint,
      useQueryAuth: config.useQueryAuth,
      expireAt: new Date(Date.now() + SESSION_TTL_MS),
      sampleRate: 16000,
      transportFrames: (data, isLast) => collector.transportFrame(data, isLast),
      onError: (err) => collector.onError(err),
      onClose: () => collector.onClose(),
    });

    try {
      await session.init();
      const connectionId = await session.start();

      return {
        session,
        collector,
        connectionId,
        createdAt: new Date(),
        requestCount: 0,
      };
    } catch (err) {
      console.error(`Failed to initialize connection ${index}:`, err);
      return null;
    }
  }

  borrow(): PooledConnection | null {
    return this.available.shift() || null;
  }

  return(conn: PooledConnection): void {
    conn.collector.reset();
    this.available.push(conn);
  }

  get availableCount(): number {
    return this.available.length;
  }

  get totalCount(): number {
    return this.allConnections.length;
  }

  getConnectionStats(): Map<number, number> {
    const stats = new Map<number, number>();
    for (const conn of this.allConnections) {
      const count = stats.get(conn.requestCount) || 0;
      stats.set(conn.requestCount, count + 1);
    }
    return stats;
  }

  async closeAll(): Promise<void> {
    console.log("Closing all connections...");
    await Promise.all(this.allConnections.map((conn) => conn.session.close()));
    this.available = [];
    this.allConnections = [];
  }
}

// Process a single audio request
async function processRequest(
  pool: AvatarConnectionPool,
  audioData: Uint8Array
): Promise<{ success: boolean; frameCount: number; durationMs: number }> {
  const startTime = Date.now();
  const conn = pool.borrow();

  if (!conn) {
    return { success: false, frameCount: 0, durationMs: Date.now() - startTime };
  }

  try {
    await conn.session.sendAudio(audioData, true);
    await conn.collector.wait(REQUEST_TIMEOUT_MS);

    if (conn.collector.error) {
      throw conn.collector.error;
    }

    conn.requestCount++;
    const durationMs = Date.now() - startTime;

    return {
      success: true,
      frameCount: conn.collector.frames.length,
      durationMs,
    };
  } catch (err) {
    return {
      success: false,
      frameCount: 0,
      durationMs: Date.now() - startTime,
    };
  } finally {
    pool.return(conn);
  }
}

// Run a single round of concurrent requests
async function runRound(
  pool: AvatarConnectionPool,
  audioData: Uint8Array,
  roundNum: number
): Promise<{ ok: number; failed: number; durationMs: number; avgFrames: number }> {
  const startTime = Date.now();

  const promises = Array.from({ length: CONCURRENT_REQUESTS }, () =>
    processRequest(pool, audioData)
  );

  const results = await Promise.all(promises);

  let ok = 0;
  let failed = 0;
  let totalFrames = 0;

  for (const result of results) {
    if (result.success) {
      ok++;
      totalFrames += result.frameCount;
    } else {
      failed++;
    }
  }

  const durationMs = Date.now() - startTime;
  const avgFrames = ok > 0 ? totalFrames / ok : 0;

  console.log(
    `Round ${roundNum}: OK=${ok}, FAILED=${failed}, Duration=${durationMs}ms, ` +
      `AvgFrames=${avgFrames.toFixed(1)}, PoolAvailable=${pool.availableCount}`
  );

  return { ok, failed, durationMs, avgFrames };
}

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

  // Load audio file
  const audioPath = path.join(import.meta.dirname, "audio_16000.pcm");
  if (!fs.existsSync(audioPath)) {
    console.error(`Audio file not found: ${audioPath}`);
    process.exit(1);
  }

  const audioData = new Uint8Array(fs.readFileSync(audioPath));
  console.log(`Loaded audio file: ${audioData.length} bytes`);

  // Create and initialize pool
  const pool = new AvatarConnectionPool();
  await pool.initialize(POOL_SIZE);

  if (pool.totalCount === 0) {
    console.error("Failed to initialize any connections");
    process.exit(1);
  }

  // Run rounds
  console.log(`\n=== Multi-Round Test ===`);
  console.log(`Pool Size: ${pool.totalCount}`);
  console.log(`Concurrent Requests: ${CONCURRENT_REQUESTS}`);
  console.log(`Rounds: ${NUM_ROUNDS}`);
  console.log(`Round Interval: ${ROUND_INTERVAL_MS / 1000}s\n`);

  const roundResults: { ok: number; failed: number; durationMs: number; avgFrames: number }[] = [];

  for (let round = 1; round <= NUM_ROUNDS; round++) {
    const result = await runRound(pool, audioData, round);
    roundResults.push(result);

    if (round < NUM_ROUNDS) {
      console.log(`Waiting ${ROUND_INTERVAL_MS / 1000}s before next round...\n`);
      await new Promise((resolve) => setTimeout(resolve, ROUND_INTERVAL_MS));
    }
  }

  // Print summary
  console.log("\n=== Summary ===");

  const totalOk = roundResults.reduce((sum, r) => sum + r.ok, 0);
  const totalFailed = roundResults.reduce((sum, r) => sum + r.failed, 0);
  const totalRequests = totalOk + totalFailed;
  const avgDuration = roundResults.reduce((sum, r) => sum + r.durationMs, 0) / roundResults.length;
  const avgFrames = roundResults.reduce((sum, r) => sum + r.avgFrames, 0) / roundResults.length;

  console.log(`Total Requests: ${totalRequests}`);
  console.log(`Success Rate: ${((totalOk / totalRequests) * 100).toFixed(1)}%`);
  console.log(`Average Round Duration: ${avgDuration.toFixed(0)}ms`);
  console.log(`Average Frames per Request: ${avgFrames.toFixed(1)}`);

  console.log("\nConnection Usage Distribution:");
  const stats = pool.getConnectionStats();
  const sortedStats = Array.from(stats.entries()).sort((a, b) => a[0] - b[0]);
  for (const [requestCount, connectionCount] of sortedStats) {
    console.log(`  ${requestCount} requests: ${connectionCount} connections`);
  }

  // Cleanup
  await pool.closeAll();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
