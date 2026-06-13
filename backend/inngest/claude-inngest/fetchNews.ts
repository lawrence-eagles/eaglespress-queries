import Parser from "rss-parser"
import pLimit from "p-limit"
import { z } from "zod"

import { inngest } from "@/lib/inngest"
import { db } from "@/db"
import { posts } from "@/db/schema"
import { redis } from "@/lib/redis"

import { FEEDS, getOrCreateSource } from "@/services/source"
import { scrapeArticle } from "@/services/scraper"
import { batchSummarize } from "@/services/ai"
import { generateSlug, ensureUniqueSlug } from "@/utils/slug"
import { detectCategoryId } from "@/services/category"
import { calculatePostScore } from "@/services/score"

import type { RawArticle, ScrapedArticle, EnrichedArticle } from "@/types"

// ── Config ─────────────────────────────────────────────────────────────────────

const RSS_PARSER           = new Parser({ timeout: 10_000 })
const SCRAPE_CONCURRENCY   = 5    // max parallel scrape requests
const AI_BATCH_SIZE        = 5    // articles per OpenAI call
const DEDUPE_TTL_SECONDS   = 86_400 // 24 hours
const MAX_ITEMS_PER_FEED   = 20   // cap per feed to avoid thundering herd

// ── Zod schema — validates each RSS item before processing ────────────────────
// FIX: original had no validation — malformed RSS items caused silent crashes
//      deep in the pipeline after wasting scraping + AI budget on them.

const RssItemSchema = z.object({
  title:          z.string().min(1),
  link:           z.string().url(),
  contentSnippet: z.string().optional(),
  enclosure:      z.object({ url: z.string().url() }).optional(),
  pubDate:        z.string().optional(),
})

function parseRssItem(
  item: Parser.Item,
  feedUrl: string
): RawArticle | null {
  const parsed = RssItemSchema.safeParse(item)

  if (!parsed.success) return null

  const { title, link, contentSnippet, enclosure, pubDate } = parsed.data

  return {
    title:       title.trim(),
    url:         link,
    description: contentSnippet ?? "",
    imageUrl:    enclosure?.url ?? null,
    feedUrl,
    publishedAt: pubDate ? new Date(pubDate) : null,
  }
}

// ── Dedupe key builder ─────────────────────────────────────────────────────────

const getDedupeKey = (url: string) => `seen:article:${url}`

// ── Main Inngest function ──────────────────────────────────────────────────────

export const fetchNews = inngest.createFunction(
  {
    id:      "fetch-news-production",
    name:    "Fetch News from RSS Feeds",
    // Prevent overlapping runs if a previous execution is still going
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: "*/10 * * * *" },

  async ({ step, logger }) => {

    // ── STEP 1: Fetch all RSS feeds ──────────────────────────────────────────
    // Each feed is fetched independently so one failure doesn't abort others.

    const rawArticles = await step.run("fetch-rss-feeds", async () => {
      const results: RawArticle[] = []
      const feedLimit = pLimit(FEEDS.length) // all feeds fetched in parallel

      const feedResults = await Promise.allSettled(
        FEEDS.map((feed) =>
          feedLimit(async () => {
            const parsed = await RSS_PARSER.parseURL(feed.url)
            const items  = parsed.items.slice(0, MAX_ITEMS_PER_FEED)

            return items
              .map((item) => parseRssItem(item, feed.url))
              .filter((a): a is RawArticle => a !== null)
          })
        )
      )

      for (const result of feedResults) {
        if (result.status === "fulfilled") {
          results.push(...result.value)
        } else {
          logger.warn("Feed fetch failed:", result.reason)
        }
      }

      logger.info(`Fetched ${results.length} raw articles from ${FEEDS.length} feeds`)
      return results
    })

    if (rawArticles.length === 0) {
      logger.info("No articles fetched — all feeds may be down")
      return { processed: 0 }
    }

    // ── STEP 2: Deduplicate ──────────────────────────────────────────────────
    //
    // FIX 1: Original fired one redis.set + one db.select per article
    //        sequentially inside a for loop — O(n) round trips.
    //        Now uses:
    //          - One pipeline redis call for all SET NX operations
    //          - One DB query with inArray for all DB existence checks
    //
    // FIX 2: Redis-first dedup prevents hitting the DB for already-seen URLs.
    //        DB check is a safety net for Redis evictions.

    const uniqueArticles = await step.run("deduplicate", async () => {
      // Redis pipeline: SET NX all URLs at once
      // Returns array of results — "OK" if set (new), null if already existed
      const pipeline = redis.pipeline()
      for (const article of rawArticles) {
        pipeline.set(getDedupeKey(article.url), "1", "NX", "EX", DEDUPE_TTL_SECONDS)
      }
      const redisResults = await pipeline.exec()

      // Filter to only articles that Redis didn't know about
      const redisNew = rawArticles.filter((_, i) => {
        const result = redisResults?.[i]
        // ioredis pipeline result is [error, value] tuple
        const value = Array.isArray(result) ? result[1] : result
        return value === "OK"
      })

      if (redisNew.length === 0) return []

      // Single DB query — check all remaining URLs at once
      // FIX: original did one db.select per article inside a for loop
      const { sql, inArray } = await import("drizzle-orm")
      const existingUrls = await db
        .select({ url: posts.url })
        .from(posts)
        .where(inArray(posts.url, redisNew.map((a) => a.url)))

      const existingSet = new Set(existingUrls.map((r) => r.url))

      const fresh = redisNew.filter((a) => !existingSet.has(a.url))

      logger.info(
        `Dedupe: ${rawArticles.length} raw → ` +
        `${redisNew.length} new to Redis → ` +
        `${fresh.length} not in DB`
      )

      return fresh
    })

    if (uniqueArticles.length === 0) {
      logger.info("All articles already processed")
      return { processed: 0 }
    }

    // ── STEP 3: Scrape full content and OG images ────────────────────────────
    //
    // FIX 1: Original re-fetched the page to extract OG image even though
    //        scrapeArticle already fetches the full page. Now combined into
    //        one fetch per article.
    //
    // FIX 2: require("cheerio") inside async callback moved to scraper.ts
    //        as a top-level import.
    //
    // FIX 3: pLimit already imported — applied here correctly.

    const scrapedArticles = await step.run("scrape-content", async () => {
      const scrapeLimit = pLimit(SCRAPE_CONCURRENCY)

      const results = await Promise.all(
        uniqueArticles.map((article) =>
          scrapeLimit(async (): Promise<ScrapedArticle> => {
            const scraped = await scrapeArticle(article.url)

            return {
              ...article,
              // Use scraped content, fall back to RSS description, fall back to title
              content:  scraped.content ?? article.description ?? article.title,
              // Use scraped OG image, fall back to RSS enclosure image
              imageUrl: scraped.imageUrl ?? article.imageUrl,
            }
          })
        )
      )

      logger.info(`Scraped ${results.length} articles`)
      return results
    })

    // ── STEP 4: AI summarization ─────────────────────────────────────────────
    //
    // FIX 1: Original sent batches but awaited them sequentially inside a for
    //        loop. Now all batches run concurrently via Promise.all.
    //
    // FIX 2: Prompt now specifies exact JSON schema — no more hallucinated
    //        response shapes that cause safeParse to silently fail.
    //
    // FIX 3: Added retry with exponential backoff inside batchSummarize.

    const enrichedArticles = await step.run("ai-summarize", async () => {
      const contents = scrapedArticles.map((a) => a.content)

      // Split into batches
      const batches: string[][] = []
      for (let i = 0; i < contents.length; i += AI_BATCH_SIZE) {
        batches.push(contents.slice(i, i + AI_BATCH_SIZE))
      }

      // FIX: run all batches concurrently instead of sequentially
      const batchLimit  = pLimit(3) // max 3 concurrent OpenAI calls
      const batchResults = await Promise.all(
        batches.map((batch) => batchLimit(() => batchSummarize(batch)))
      )

      // Flatten batch results back into flat array
      const summaries = batchResults.flat()

      const enriched: EnrichedArticle[] = scrapedArticles.map((article, i) => ({
        ...article,
        summary: summaries[i]?.summary ?? article.content.slice(0, 200),
      }))

      logger.info(`Summarized ${enriched.length} articles`)
      return enriched
    })

    // ── STEP 5: Persist to database ──────────────────────────────────────────
    //
    // FIX 1: Original used a sequential for loop with await inside —
    //        O(n) sequential DB operations. Now runs concurrently with pLimit.
    //
    // FIX 2: No onConflictDoNothing on posts.insert — a race condition between
    //        two concurrent Inngest executions could cause a duplicate key error
    //        that kills the entire save step. Now uses onConflictDoNothing.
    //
    // FIX 3: Slug uniqueness check and category detection ran serially inside
    //        the loop. Now run concurrently per article via Promise.allSettled.
    //
    // FIX 4: Promise.allSettled instead of Promise.all — one failed insert
    //        no longer aborts all remaining inserts.

    const saveResults = await step.run("save-to-database", async () => {
      const saveLimit = pLimit(10) // max 10 concurrent DB writes

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          saveLimit(async () => {
            // Run slug + source + category lookups concurrently per article
            const [slug, source, categoryId] = await Promise.all([
              ensureUniqueSlug(generateSlug(article.title)),
              getOrCreateSource(article.feedUrl),
              detectCategoryId(`${article.title} ${article.content}`),
            ])

            const score = calculatePostScore({
              title:       article.title,
              content:     article.content,
              hasImage:    !!article.imageUrl,
              publishedAt: article.publishedAt,
            })

            // FIX: onConflictDoNothing prevents duplicate key crash on race condition
            await db
              .insert(posts)
              .values({
                title:       article.title,
                slug,
                description: article.summary,
                url:         article.url,
                imageUrl:    article.imageUrl,
                sourceId:    source.id,
                categoryId,
                score,
                publishedAt: article.publishedAt ?? new Date(),
              })
              .onConflictDoNothing({ target: posts.url })

            return article.url
          })
        )
      )

      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed    = results.filter((r) => r.status === "rejected")

      // Log individual failures without crashing the step
      for (const failure of failed) {
        if (failure.status === "rejected") {
          logger.error("Article insert failed:", failure.reason)
        }
      }

      return { succeeded, failed: failed.length }
    })

    logger.info(
      `✅ Pipeline complete: ${saveResults.succeeded} saved, ` +
      `${saveResults.failed} failed`
    )

    return {
      processed: enrichedArticles.length,
      saved:     saveResults.succeeded,
      failed:    saveResults.failed,
    }
  }
)
