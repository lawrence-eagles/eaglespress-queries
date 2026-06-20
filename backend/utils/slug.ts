// BUG FIX: This file previously exported a second `buildPostCacheKey` function
// that conflicted with the canonical async versioned one in util/cache.ts.
// The two had different signatures, different key formats, and different
// behaviour — a static sync function here vs an async versioned function there.
// single-post.ts correctly imports from "@/utils/cache" (the async version),
// so the one here was dead code that could cause confusion if ever imported
// accidentally. Removed entirely. cache.ts is the single source of truth
// for all cache key builders.

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
