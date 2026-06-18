import Parser from "rss-parser";
import pLimit from "p-limit";
import { z } from "zod";
import { inArray } from "drizzle-orm";

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
const FEED_CONCURRENCY = 5;
const SCRAPE_CONCURRENCY = 5;
const AI_BATCH_SIZE = 5;
const SAVE_CONCURRENCY = 10;
const DEDUPE_TTL_SECONDS = 86_400;
const MAX_ITEMS_PER_FEED = 20;

// ── Zod schema ────────────────────────────────────────────────────────────────

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
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: "*/10 * * * *" },

  async ({ step, logger }) => {
    // ── STEP 1: Fetch all RSS feeds ──────────────────────────────────────────

    const rawArticles = await step.run("fetch-rss-feeds", async () => {
      const results: RawArticle[] = [];
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

    const uniqueArticles = await step.run("deduplicate", async () => {
      const multi = redis.multi();

      for (const article of rawArticles) {
        multi.set(getDedupeKey(article.url), "1", {
          NX: true,
          EX: DEDUPE_TTL_SECONDS,
        });
      }

      const multiResults = await multi.exec();
      const redisNew = rawArticles.filter((_, i) => multiResults[i] === "OK");

      if (redisNew.length === 0) return [];

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

    // ── STEP 3: Scrape content ───────────────────────────────────────────────

    const scrapedArticles = await step.run("scrape-content", async () => {
      const scrapeLimit = pLimit(SCRAPE_CONCURRENCY);

      const results = await Promise.all(
        uniqueArticles.map((article) =>
          scrapeLimit(async (): Promise<ScrapedArticle> => {
            const scraped = await scrapeArticle(article.url);

            return {
              ...article,
              content: scraped.content ?? article.description ?? article.title,
              imageUrl: scraped.imageUrl ?? article.imageUrl,
            };
          }),
        ),
      );

      logger.info(`Scraped ${results.length} articles`);
      return results;
    });

    // ── STEP 4: AI summarization ─────────────────────────────────────────────

    const enrichedArticles = await step.run("ai-summarize", async () => {
      const contents = scrapedArticles.map((a) => a.content);

      const batches: string[][] = [];
      for (let i = 0; i < contents.length; i += AI_BATCH_SIZE) {
        batches.push(contents.slice(i, i + AI_BATCH_SIZE));
      }

      const batchLimit = pLimit(3);
      const batchResults = await Promise.all(
        batches.map((batch) => batchLimit(() => batchSummarize(batch))),
      );

      const summaries = batchResults.flat();

      return scrapedArticles.map((article, i) => ({
        ...article,
        summary: summaries[i]?.summary ?? article.content.slice(0, 200),
      }));
    });

    // ── STEP 5: Save to DB ───────────────────────────────────────────────────

    const saveResults = await step.run("save-to-database", async () => {
      const saveLimit = pLimit(SAVE_CONCURRENCY);

      const results = await Promise.allSettled(
        enrichedArticles.map((article) =>
          saveLimit(async () => {
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

    // ── STEP 6: ✅ VERSIONED CACHE INVALIDATION (O(1)) ───────────────────────

    if (saveResults.succeeded > 0) {
      await step.run("bump-cache-versions", async () => {
        try {
          const multi = redis.multi();

          // 🔥 GLOBAL FEED INVALIDATION (all users)
          multi.incr("feed:global:version");

          // 🔥 TRENDING INVALIDATION
          multi.incr("feed:trending:version");

          await multi.exec();

          logger.info("[cache] Feed + trending versions bumped");
        } catch (err) {
          logger.warn(
            `[cache] Version bump failed (non-fatal): ${(err as Error).message}`,
          );
        }
      });
    } else {
      logger.info("[cache] No new posts saved — skipping invalidation");
    }

    logger.info(
      `✅ Pipeline complete: ${saveResults.succeeded} saved, ${saveResults.failed} failed`,
    );

    return {
      processed: enrichedArticles.length,
      saved: saveResults.succeeded,
      failed: saveResults.failed,
    };
  },
);
