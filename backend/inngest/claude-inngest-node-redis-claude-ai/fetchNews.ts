import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm"; // BUG FIX: was dynamic import inside step.run

import { inngest } from "@/lib/inngest";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { redis } from "@/lib/redis";

import { FEEDS, getOrCreateSource } from "@/services/source";
import { scrapeArticle } from "@/services/scraper";
import { batchSummarize } from "@/services/ai";
import { generateSlug, ensureUniqueSlug } from "@/utils/slug";
import { detectCategoryId } from "@/services/category";
import { calculatePostScore } from "@/services/score";

import type { RawArticle, ScrapedArticle, EnrichedArticle } from "@/types";

// ── Config ─────────────────────────────────────────────────────────────────────

const RSS_PARSER = new Parser({ timeout: 10_000 });
const FEED_CONCURRENCY = 5; // BUG FIX: was pLimit(FEEDS.length) which equals
// pLimit(12) — limit === total tasks === no limiting.
// Fixed to a meaningful cap of 5.
const SCRAPE_CONCURRENCY = 5; // max parallel scrape requests
const AI_BATCH_SIZE = 5; // articles per gpt-4o-mini call
const SAVE_CONCURRENCY = 10; // max parallel DB writes
const DEDUPE_TTL_SECONDS = 86_400; // 24 hours
const MAX_ITEMS_PER_FEED = 20; // cap per feed to avoid thundering herd

// ── Zod schema — validates each RSS item before processing ────────────────────

const RssItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().url(),
  contentSnippet: z.string().optional(),
  enclosure: z.object({ url: z.string().url() }).optional(),
  pubDate: z.string().optional(),
});

function parseRssItem(item: Parser.Item, feedUrl: string): RawArticle | null {
  const parsed = RssItemSchema.safeParse(item);
  if (!parsed.success) return null;

  const { title, link, contentSnippet, enclosure, pubDate } = parsed.data;

  return {
    title: title.trim(),
    url: link,
    description: contentSnippet ?? "",
    imageUrl: enclosure?.url ?? null,
    feedUrl,
    publishedAt: pubDate ? new Date(pubDate) : null,
  };
}

// ── Dedupe key builder ─────────────────────────────────────────────────────────

const getDedupeKey = (url: string) => `seen:article:${url}`;

// ── Main Inngest function ──────────────────────────────────────────────────────

export const fetchNews = inngest.createFunction(
  {
    id: "fetch-news-production",
    name: "Fetch News from RSS Feeds",
    concurrency: { limit: 1 }, // prevent overlapping runs
    retries: 2,
  },
  { cron: "*/10 * * * *" },

  async ({ step, logger }) => {
    // ── STEP 1: Fetch all RSS feeds ──────────────────────────────────────────
    // Each feed is fetched independently so one failure doesn't abort others.

    const rawArticles = await step.run("fetch-rss-feeds", async () => {
      const results: RawArticle[] = [];

      // BUG FIX: was pLimit(FEEDS.length) — a limit equal to the total number
      // of tasks does nothing (same as Promise.all with extra overhead).
      // Fixed to FEED_CONCURRENCY = 5 for a real meaningful cap.
      const feedLimit = pLimit(FEED_CONCURRENCY);

      const feedResults = await Promise.allSettled(
        FEEDS.map((feed) =>
          feedLimit(async () => {
            const parsed = await RSS_PARSER.parseURL(feed.url);
            return parsed.items
              .slice(0, MAX_ITEMS_PER_FEED)
              .map((item) => parseRssItem(item, feed.url))
              .filter((a): a is RawArticle => a !== null);
          }),
        ),
      );

      for (const result of feedResults) {
        if (result.status === "fulfilled") {
          results.push(...result.value);
        } else {
          logger.warn("Feed fetch failed:", result.reason);
        }
      }

      logger.info(
        `Fetched ${results.length} raw articles from ${FEEDS.length} feeds`,
      );
      return results;
    });

    if (rawArticles.length === 0) {
      logger.info("No articles fetched — all feeds may be down");
      return { processed: 0 };
    }

    // ── STEP 2: Deduplicate ──────────────────────────────────────────────────
    //
    // BUG FIX — node-redis migration:
    //
    //   BEFORE (ioredis):
    //     const pipeline = redis.pipeline()
    //     pipeline.set(key, "1", "NX", "EX", TTL)   ← positional args
    //     const results = await pipeline.exec()
    //     const value = Array.isArray(result) ? result[1] : result  ← tuple unwrap
    //
    //   AFTER (node-redis):
    //     const multi = redis.multi()
    //     multi.set(key, "1", { NX: true, EX: TTL })  ← object options
    //     const results = await multi.exec()
    //     results[i] === "OK"  ← flat value array, no tuple unwrapping
    //
    //   node-redis multi().exec() returns a flat value[] array.
    //   ioredis pipeline().exec() returns [error, value][] tuples.
    //   These are incompatible — using ioredis tuple logic against node-redis
    //   causes every result check to silently fail (value is never result[1]).
    //
    // BUG FIX — dynamic import:
    //   `const { sql, inArray } = await import("drizzle-orm")` was inside step.run.
    //   Dynamic imports inside Inngest steps are non-deterministic on replay.
    //   `sql` was also imported but never used — dead import.
    //   Fixed: static top-level import of inArray only (see top of file).

    const uniqueArticles = await step.run("deduplicate", async () => {
      // node-redis v4: use multi() instead of pipeline()
      const multi = redis.multi();

      for (const article of rawArticles) {
        // node-redis v4: object options syntax — not positional strings
        multi.set(getDedupeKey(article.url), "1", {
          NX: true,
          EX: DEDUPE_TTL_SECONDS,
        });
      }

      // node-redis multi().exec() returns flat value[] — no [error, value] tuples
      const multiResults = await multi.exec();

      // SET NX returns "OK" for new keys, null if key already existed
      const redisNew = rawArticles.filter((_, i) => multiResults[i] === "OK");

      if (redisNew.length === 0) return [];

      // Single DB query — check all remaining URLs at once
      const existingUrls = await db
        .select({ url: posts.url })
        .from(posts)
        .where(
          inArray(
            posts.url,
            redisNew.map((a) => a.url),
          ),
        );

      const existingSet = new Set(existingUrls.map((r) => r.url));
      const fresh = redisNew.filter((a) => !existingSet.has(a.url));

      logger.info(
        `Dedupe: ${rawArticles.length} raw → ` +
          `${redisNew.length} new to Redis → ` +
          `${fresh.length} not in DB`,
      );

      return fresh;
    });

    if (uniqueArticles.length === 0) {
      logger.info("All articles already processed");
      return { processed: 0 };
    }

    // ── STEP 3: Scrape full content and OG images ────────────────────────────

    const scrapedArticles = await step.run("scrape-content", async () => {
      const scrapeLimit = pLimit(SCRAPE_CONCURRENCY);

      const results = await Promise.all(
        uniqueArticles.map((article) =>
          scrapeLimit(async (): Promise<ScrapedArticle> => {
            const scraped = await scrapeArticle(article.url);

            return {
              ...article,
              // Use scraped content, fall back to RSS description, then title
              content: scraped.content ?? article.description ?? article.title,
              // Use scraped OG image, fall back to RSS enclosure image
              imageUrl: scraped.imageUrl ?? article.imageUrl,
            };
          }),
        ),
      );

      logger.info(`Scraped ${results.length} articles`);
      return results;
    });

    // ── STEP 4: AI summarization (gpt-4o-mini) ───────────────────────────────

    const enrichedArticles = await step.run("ai-summarize", async () => {
      const contents = scrapedArticles.map((a) => a.content);

      // Split into batches of AI_BATCH_SIZE
      const batches: string[][] = [];
      for (let i = 0; i < contents.length; i += AI_BATCH_SIZE) {
        batches.push(contents.slice(i, i + AI_BATCH_SIZE));
      }

      // Run batches concurrently — max 3 parallel gpt-4o-mini calls
      const batchLimit = pLimit(3);
      const batchResults = await Promise.all(
        batches.map((batch) => batchLimit(() => batchSummarize(batch))),
      );

      const summaries = batchResults.flat();

      const enriched: EnrichedArticle[] = scrapedArticles.map((article, i) => ({
        ...article,
        summary: summaries[i]?.summary ?? article.content.slice(0, 200),
      }));

      logger.info(`Summarized ${enriched.length} articles`);
      return enriched;
    });

    // ── STEP 5: Persist to database ──────────────────────────────────────────

    const saveResults = await step.run("save-to-database", async () => {
      const saveLimit = pLimit(SAVE_CONCURRENCY);

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          saveLimit(async () => {
            // Run slug + source + category lookups concurrently per article
            const [slug, source, categoryId] = await Promise.all([
              ensureUniqueSlug(generateSlug(article.title)),
              getOrCreateSource(article.feedUrl),
              detectCategoryId(`${article.title} ${article.content}`),
            ]);

            const score = calculatePostScore({
              title: article.title,
              content: article.content,
              hasImage: !!article.imageUrl,
              publishedAt: article.publishedAt,
            });

            // onConflictDoNothing prevents duplicate key crash on race condition
            await db
              .insert(posts)
              .values({
                title: article.title,
                slug,
                description: article.summary,
                url: article.url,
                imageUrl: article.imageUrl,
                sourceId: source.id,
                categoryId,
                score,
                publishedAt: article.publishedAt ?? new Date(),
              })
              .onConflictDoNothing({ target: posts.url });

            return article.url;
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected");

      for (const failure of failed) {
        if (failure.status === "rejected") {
          logger.error("Article insert failed:", failure.reason);
        }
      }

      return { succeeded, failed: failed.length };
    });

    logger.info(
      `✅ Pipeline complete: ${saveResults.succeeded} saved, ` +
        `${saveResults.failed} failed`,
    );

    return {
      processed: enrichedArticles.length,
      saved: saveResults.succeeded,
      failed: saveResults.failed,
    };
  },
);
