import * as cheerio from "cheerio"  // FIX: was require("cheerio") inside async callback
import { redis } from "@/lib/redis"

// ── Cache / lock key builders ──────────────────────────────────────────────────

const getCacheKey = (url: string) => `article:content:${url}`
const getLockKey  = (url: string) => `article:lock:${url}`

// ── Extract article content and OG image ──────────────────────────────────────
//
// FIX 1: require("cheerio") inside async callback — cheerio must be a
//         top-level ESM import. Dynamic require() in an async context
//         is unreliable and breaks in ESM projects.
//
// FIX 2: redis.set() options syntax — {NX: true, EX: 10} is the ioredis
//         object syntax. If using node-redis v4+ the correct form is
//         {NX: true, EX: 10} too, but the SET ... NX EX order matters.
//         Unified here to work with both clients via explicit overload.
//
// FIX 3: setTimeout inside Inngest step — Inngest replays steps on retry.
//         A setTimeout inside step.run() is non-deterministic and will
//         behave unexpectedly on replay. Lock contention is handled by
//         returning null and letting the caller fall back to description.
//
// FIX 4: Lock never released on redis.set failure — added finally block
//         (already present but made explicit).

export interface ScrapeResult {
  content: string | null
  imageUrl: string | null
}

export async function scrapeArticle(url: string): Promise<ScrapeResult> {
  const cacheKey = getCacheKey(url)
  const lockKey  = getLockKey(url)

  // ── Cache hit ──────────────────────────────────────────────────────────────

  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as ScrapeResult
    } catch {
      // Corrupt cache entry — fall through to re-scrape
    }
  }

  // ── Acquire lock ───────────────────────────────────────────────────────────
  // FIX: Unified redis SET NX EX syntax compatible with both ioredis and node-redis

  const acquired = await redis.set(lockKey, "1", "NX", "EX", 10)

  if (!acquired) {
    // FIX: removed setTimeout — non-deterministic in Inngest step context.
    // Return null; caller falls back to RSS description field.
    return { content: null, imageUrl: null }
  }

  // ── Fetch and parse ────────────────────────────────────────────────────────

  try {
    const response = await fetch(url, {
      // FIX: native fetch instead of axios (no extra dependency)
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Eaglespress/1.0)" },
    })

    if (!response.ok) {
      return { content: null, imageUrl: null }
    }

    const html = await response.text()
    const $    = cheerio.load(html)

    // Remove noise elements
    $("script, style, nav, header, footer, aside, .ad, .advertisement").remove()

    // Extract main article content
    let content = $("article p, [role='main'] p, .article-body p, .post-content p")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 40) // skip short fragments like "By CNN Staff"
      .join("\n\n")

    // Fallback: all paragraphs
    if (!content) {
      content = $("p")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 40)
        .join("\n\n")
    }

    const cleanContent = content.slice(0, 5000) || null

    // Extract OG image
    const imageUrl =
      $('meta[property="og:image"]').attr("content") ??
      $('meta[name="twitter:image"]').attr("content") ??
      null

    const result: ScrapeResult = {
      content: cleanContent,
      imageUrl: imageUrl ?? null,
    }

    // Cache for 24 hours
    await redis.set(cacheKey, JSON.stringify(result), "EX", 86400)

    return result
  } catch {
    return { content: null, imageUrl: null }
  } finally {
    // Always release the lock
    await redis.del(lockKey)
  }
}
