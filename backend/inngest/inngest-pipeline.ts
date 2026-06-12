// INNGEST PIPLINE CODE

// /utils/slug.ts
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

// /services/source.ts
import { db } from "@/db";
import { sources } from "@/db/schema";
import { eq } from "drizzle-orm";

// ✅ SINGLE SOURCE OF TRUTH
export const FEEDS = [
  { name: "CNN", url: "http://rss.cnn.com/rss/edition.rss" },
  { name: "BBC", url: "http://feeds.bbci.co.uk/news/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  {
    name: "Reuters",
    url: "https://www.reutersagency.com/feed/?best-topics=business-finance",
  },
  {
    name: "NYTimes",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  },
  { name: "Guardian", url: "https://www.theguardian.com/world/rss" },
  { name: "Punch", url: "https://punchng.com/feed/" },
  { name: "Vanguard", url: "https://www.vanguardngr.com/feed/" },
  { name: "Channels", url: "https://www.channelstv.com/feed/" },
  { name: "Arise", url: "https://www.arise.tv/feed/" },
  { name: "TechCabal", url: "https://techcabal.com/feed/" },
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss" },
];

function getFeedConfig(url: string) {
  return FEEDS.find((f) => f.url === url);
}

export async function getOrCreateSource(feedUrl: string) {
  const feedConfig = getFeedConfig(feedUrl);
  if (!feedConfig) throw new Error(`Feed URL not registered: ${feedUrl}`);

  const existing = await db
    .select()
    .from(sources)
    .where(eq(sources.url, feedConfig.url))
    .limit(1);

  if (existing.length) return existing[0];

  try {
    const inserted = await db
      .insert(sources)
      .values({
        name: feedConfig.name,
        url: feedConfig.url,
      })
      .returning();

    return inserted[0];
  } catch (err: any) {
    if (err.code === "23505") {
      const retry = await db
        .select()
        .from(sources)
        .where(eq(sources.url, feedConfig.url))
        .limit(1);

      if (retry.length) return retry[0];
    }
    throw err;
  }
}

// /services/scraper.ts
import axios from "axios";
import * as cheerio from "cheerio";
import { redis } from "@/lib/redis";

function getCacheKey(url: string) {
  return `article:${url}`;
}

function getLockKey(url: string) {
  return `lock:${url}`;
}

export async function extractArticleContent(url: string) {
  const cacheKey = getCacheKey(url);
  const lockKey = getLockKey(url);

  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const lock = await redis.set(lockKey, "1", {
    NX: true,
    EX: 10,
  });

  if (!lock) {
    await new Promise((r) => setTimeout(r, 500));
    return await redis.get(cacheKey);
  }

  try {
    const { data } = await axios.get(url, {
      timeout: 5000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(data);

    let text = $("article p")
      .map((_, el) => $(el).text())
      .get()
      .join("\n");

    if (!text) {
      text = $("p")
        .map((_, el) => $(el).text())
        .get()
        .join("\n");
    }

    const cleanText = text.slice(0, 5000);

    await redis.set(cacheKey, cleanText, { EX: 86400 });

    return cleanText;
  } catch {
    return null;
  } finally {
    await redis.del(lockKey);
  }
}

// /services/ai.ts
import axios from "axios";

function safeParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function batchSummarize(contents: string[]) {
  try {
    const prompt = contents
      .map((c, i) => `Article ${i + 1}:\n${c}`)
      .join("\n\n");

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Summarize each article in 2 sentences.\n\nReturn JSON.\n\n${prompt}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      },
    );

    const parsed = safeParse(res.data.choices[0].message.content);

    if (!parsed) throw new Error("Invalid JSON");

    return parsed;
  } catch {
    return contents.map((c, i) => ({
      index: i + 1,
      summary: c.slice(0, 200),
    }));
  }
}

// /services/fetchNews.ts
import { inngest } from "@/lib/inngest";
import Parser from "rss-parser";
import axios from "axios";
import pLimit from "p-limit";

import { db } from "@/db";
import { posts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { redis } from "@/lib/redis";

import { FEEDS, getOrCreateSource } from "@/services/source";
import { extractArticleContent } from "@/services/scraper";
import { batchSummarize } from "@/services/ai";
import { generateSlug } from "@/utils/slug";
import { detectCategoryId } from "@/services/category";
import { calculatePostScore } from "@/services/score";

const parser = new Parser();
const limit = pLimit(5);

const DEDUPE_TTL = 86400;

function getDedupeKey(url: string) {
  return `seen:${url}`;
}

async function ensureUniqueSlug(baseSlug: string) {
  let slug = baseSlug;

  for (let i = 0; i < 50; i++) {
    const exists = await db
      .select()
      .from(posts)
      .where(eq(posts.slug, slug))
      .limit(1);

    if (!exists.length) return slug;
    slug = `${baseSlug}-${i + 1}`;
  }

  return `${baseSlug}-${Date.now()}`;
}

export const fetchNews = inngest.createFunction(
  { id: "fetch-news-production" },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    const articles = await step.run("fetch", async () => {
      const results: any[] = [];

      for (const feed of FEEDS) {
        try {
          const parsed = await parser.parseURL(feed.url);

          for (const item of parsed.items) {
            if (!item.link) continue;

            results.push({
              title: item.title || "",
              url: item.link,
              description: item.contentSnippet || "",
              imageUrl:
                item.enclosure?.url || item["media:content"]?.url || null,
              feedUrl: feed.url, // ✅ critical fix
            });
          }
        } catch {
          console.error("Feed failed:", feed.url);
        }
      }

      return results;
    });

    const uniqueArticles = await step.run("dedupe", async () => {
      const out = [];

      for (const a of articles) {
        const key = getDedupeKey(a.url);

        const wasSet = await redis.set(key, "1", {
          NX: true,
          EX: DEDUPE_TTL,
        });

        if (!wasSet) continue;

        const exists = await db
          .select()
          .from(posts)
          .where(eq(posts.url, a.url))
          .limit(1);

        if (exists.length) continue;

        out.push(a);
      }

      return out;
    });

    if (!uniqueArticles.length) return;

    const scraped = await step.run("scrape", async () => {
      return Promise.all(
        uniqueArticles.map((a) =>
          limit(async () => {
            const content =
              (await extractArticleContent(a.url)) || a.description || a.title;

            let imageUrl = a.imageUrl;

            if (!imageUrl) {
              try {
                const { data } = await axios.get(a.url);
                const $ = require("cheerio").load(data);
                imageUrl =
                  $('meta[property="og:image"]').attr("content") ||
                  $('meta[name="twitter:image"]').attr("content") ||
                  null;
              } catch {}
            }

            return { content, imageUrl };
          }),
        ),
      );
    });

    const summaries = await step.run("ai", async () => {
      const contents = scraped.map((s) => s.content);
      const batches = [];

      for (let i = 0; i < contents.length; i += 5) {
        batches.push(contents.slice(i, i + 5));
      }

      const results = [];

      for (const batch of batches) {
        const res = await batchSummarize(batch);

        for (let i = 0; i < batch.length; i++) {
          results.push(res?.[i]?.summary || batch[i].slice(0, 200));
        }
      }

      return results;
    });

    await step.run("save", async () => {
      for (let i = 0; i < uniqueArticles.length; i++) {
        const article = uniqueArticles[i];

        try {
          const baseSlug = generateSlug(article.title);
          const slug = await ensureUniqueSlug(baseSlug);

          const source = await getOrCreateSource(article.feedUrl);

          const categoryId = await detectCategoryId(
            article.title + " " + scraped[i].content,
          );

          const score = calculatePostScore({
            title: article.title,
            content: scraped[i].content,
            hasImage: !!scraped[i].imageUrl,
          });

          await db.insert(posts).values({
            title: article.title,
            slug,
            description: summaries[i],
            url: article.url,
            imageUrl: scraped[i].imageUrl,
            sourceId: source.id, // ✅ fixed
            categoryId,
            score,
          });
        } catch (err) {
          console.error("Insert failed:", article.url);
        }
      }
    });

    console.log(`✅ Processed ${uniqueArticles.length} articles`);
  },
);
