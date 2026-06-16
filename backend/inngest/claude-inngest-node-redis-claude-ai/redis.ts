import { createClient } from "redis";

// ── Validate env at module load ────────────────────────────────────────────────

if (!process.env.REDIS_URL) {
  throw new Error(
    "REDIS_URL environment variable is not set.\n" +
      "Add it to your .env file. Example: REDIS_URL=redis://localhost:6379",
  );
}

// ── Create node-redis v4 client ────────────────────────────────────────────────
//
// Key differences from ioredis:
//   - Requires explicit .connect() call before use
//   - SET options use object syntax: { NX: true, EX: 10 }
//   - multi() instead of pipeline()
//   - multi().exec() returns flat value[] array (no [error, value] tuples)
//   - .get() returns string | null (same as ioredis)
//   - .del() accepts string | string[] (same as ioredis)

export const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    // Exponential backoff: 100ms → 200ms → 400ms → ... capped at 3s
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("[redis] Max reconnect attempts reached — giving up");
        return new Error("Redis reconnect limit exceeded");
      }
      return Math.min(retries * 100, 3_000);
    },
    connectTimeout: 5_000,
  },
});

redis.on("connect", () => console.log("[redis] Connected"));
redis.on("reconnecting", () => console.warn("[redis] Reconnecting..."));
redis.on("error", (err: Error) =>
  console.error("[redis] Client error:", err.message),
);

// node-redis v4 requires an explicit connect() — unlike ioredis which connects lazily.
// This top-level await is valid in ESM and in Node.js 14.8+.
await redis.connect();
