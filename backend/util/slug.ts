export function generateSlug(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

// /utils/cache.ts

/**
 * Builds a consistent Redis cache key for a post
 * Uses versioning so you can safely invalidate all keys later
 */

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "post";

export function buildPostCacheKey(slug: string): string {
  if (!slug || typeof slug !== "string") {
    throw new Error("Invalid slug provided to buildPostCacheKey");
  }

  // Normalize slug (important for cache consistency)
  const normalizedSlug = slug.trim().toLowerCase();

  return `${CACHE_PREFIX}:${CACHE_VERSION}:${normalizedSlug}`;
}
