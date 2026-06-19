// /utils/cache.ts

import { redis } from "@/lib/redis";

// ===============================
// 🔥 VERSION HELPERS
// ===============================

async function getVersion(key: string): Promise<string> {
  const v = await redis.get(key);
  return v ?? "1";
}

/**
 * 🔥 Smart version resolver
 * Priority:
 * 1. Specific key (user/post/etc)
 * 2. Global fallback
 * 3. Default "1"
 */
async function getVersionWithFallback(
  primaryKey: string,
  fallbackKey?: string,
): Promise<string> {
  const primary = await redis.get(primaryKey);
  if (primary) return primary;

  if (fallbackKey) {
    const fallback = await redis.get(fallbackKey);
    if (fallback) return fallback;
  }

  return "1";
}

// ===============================
// 🔥 POST CACHE
// ===============================

export async function buildPostCacheKey(slug: string): Promise<string> {
  const version = await getVersion(`post:${slug}:version`);
  return `post:slug:${slug}:v${version}`;
}

// ===============================
// 🔥 USER FEED CACHE (UPDATED)
// ===============================

// export async function buildFeedKey(
//   userId: string,
//   cursor: string | null,
// ): Promise<string> {
//   const version = await getVersionWithFallback(
//     `feed:${userId}:version`, // user-specific override
//     "feed:global:version", // 🔥 global fallback
//   );

//   return cursor
//     ? `feed:${userId}:v${version}:cursor:${cursor}`
//     : `feed:${userId}:v${version}:start`;
// }

// /utils/cache.ts

export async function buildFeedKey(
  userId: string,
  cursor: string | null,
  versions?: { userVersion?: string | null; globalVersion?: string | null },
): Promise<string> {
  let userVersion = versions?.userVersion;
  let globalVersion = versions?.globalVersion;

  // Fallback to Redis ONLY if not provided
  if (!userVersion) {
    userVersion = await redis.get(`feed:${userId}:version`);
  }

  if (!globalVersion) {
    globalVersion = await redis.get("feed:global:version");
  }

  const finalVersion = userVersion ?? globalVersion ?? "1";

  return cursor
    ? `feed:${userId}:v${finalVersion}:cursor:${cursor}`
    : `feed:${userId}:v${finalVersion}:start`;
}

// ===============================
// 🔥 TRENDING CACHE (UNCHANGED)
// ===============================

export async function buildTrendingKey(cursor: string | null): Promise<string> {
  const version = await getVersion(`feed:trending:version`);

  return cursor
    ? `feed:trending:v${version}:cursor:${cursor}`
    : `feed:trending:v${version}:start`;
}

// ===============================
// 🔥 BOOKMARK CACHE (UNCHANGED)
// ===============================

export async function buildBookmarksKey(
  userId: string,
  cursor: string | null,
): Promise<string> {
  const version = await getVersion(`bookmarks:${userId}:version`);

  return cursor
    ? `feed:bookmarks:${userId}:v${version}:cursor:${cursor}`
    : `feed:bookmarks:${userId}:v${version}:start`;
}

// ===============================
// 🔥 FOLLOWING CACHE (UNCHANGED)
// ===============================

export async function buildFollowingKey(
  userId: string,
  cursor: string | null,
): Promise<string> {
  const version = await getVersion(`following:${userId}:version`);

  return cursor
    ? `feed:following:${userId}:v${version}:cursor:${cursor}`
    : `feed:following:${userId}:v${version}:start`;
}

// =========================
// CACHE KEY
// =========================
export async function buildCommentsKey(postId: string, cursor: string | null) {
  const version = (await redis.get(`comments:${postId}:version`)) ?? "1";

  return cursor
    ? `comments:${postId}:v${version}:c:${cursor}`
    : `comments:${postId}:v${version}:start`;
}
