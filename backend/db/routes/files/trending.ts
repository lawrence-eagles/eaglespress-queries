import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildTrendingKey } from "@/utils/cache";

const router = Router();

const PAGE_SIZE = 20;
const CACHE_TTL = 30;

// ── Cursor ────────────────────────────────────────────────────────────────────
// score kept as string to avoid JS float precision loss on large values

type Cursor = {
  score: string;
  createdAt: string;
  id: string;
};

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  return JSON.parse(
    Buffer.from(raw, "base64url").toString("utf-8"),
  ) as Cursor;
}

// ── Row type ──────────────────────────────────────────────────────────────────

interface TrendingRow {
  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  created_at: Date;
  category_id: string | null;
  source_id: string | null;
  category_name: string | null;
  source_name: string | null;
  source_website: string | null;
  likes_count: number | string;
  comments_count: number | string;
  trend_score: number | string;
  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    // userId is optional — trending is a global feed accessible without auth.
    // EXISTS subqueries with NULL safely return false for guests.
    const userId      = (req.query.userId as string) || null;
    const cursorParam = (req.query.cursor as string) || null;

    // BUG FIX: buildTrendingKey is async (calls redis.get for versioning)
    // but was called WITHOUT await, making cacheKey a Promise<string>.
    // Every redis.get(cacheKey) and redis.set(cacheKey, ...) was silently
    // using "[object Promise]" as the key — cache never hit, never wrote.
    const cacheKey = await buildTrendingKey(cursorParam);

    // ── 1. Cache (first page only) ────────────────────────────────────────────

    if (!cursorParam) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    }

    // ── 2. Decode cursor ──────────────────────────────────────────────────────

    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // ── 3. Query ──────────────────────────────────────────────────────────────

    const query = sql`
      WITH scored_posts AS (
        SELECT
          p.id,
          p.title,
          p.slug,
          p.image_url,
          p.description,
          p.url,
          p.created_at,
          p.category_id,
          p.source_id,

          p.likes_count,
          p.comments_count,

          c.name AS category_name,
          s.name AS source_name,
          s.url  AS source_website,

          (
            (COALESCE(p.score, 0) * 3)
            - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
          ) AS trend_score

        FROM posts p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN sources     s ON s.id = p.source_id
      )

      SELECT
        sp.*,

        EXISTS (
          SELECT 1 FROM likes l
          WHERE l.post_id = sp.id
            AND l.user_id = ${userId}
        ) AS user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = sp.id
            AND b.user_id = ${userId}
        ) AS user_bookmarked

      FROM scored_posts sp

      ${
        cursor
          ? sql`
        WHERE (
          sp.trend_score < ${cursor.score}::float
          OR (
            sp.trend_score = ${cursor.score}::float
            AND sp.created_at < ${cursor.createdAt}::timestamp
          )
          OR (
            sp.trend_score = ${cursor.score}::float
            AND sp.created_at = ${cursor.createdAt}::timestamp
            AND sp.id < ${cursor.id}::uuid
          )
        )
      `
          : sql``
      }

      ORDER BY
        sp.trend_score DESC,
        sp.created_at  DESC,
        sp.id          DESC

      LIMIT ${PAGE_SIZE}
    `;

    const result = await db.execute(query);
    const rows   = result.rows as TrendingRow[];

    // ── 4. Map response ───────────────────────────────────────────────────────

    const items = rows.map((p) => ({
      id:    p.id,
      title: p.title,
      slug:  p.slug,

      imageUrl:  p.image_url,
      summary:   p.description,
      sourceUrl: p.url,

      createdAt: new Date(p.created_at).toISOString(),

      category:   p.category_name,
      categoryId: p.category_id,

      sourceName:    p.source_name,
      sourceWebsite: p.source_website,

      likesCount:    Number(p.likes_count)    || 0,
      commentsCount: Number(p.comments_count) || 0,

      // pg driver returns EXISTS as boolean or "t"/"f" string — cast both
      isLiked:      p.user_liked      === true || p.user_liked      === "t",
      isBookmarked: p.user_bookmarked === true || p.user_bookmarked === "t",
    }));

    // ── 5. Next cursor ────────────────────────────────────────────────────────

    let nextCursor: string | null = null;

    if (rows.length === PAGE_SIZE) {
      const last = rows[rows.length - 1];

      nextCursor = encodeCursor({
        score:     String(last.trend_score),
        createdAt: new Date(last.created_at).toISOString(),
        id:        last.id,
      });
    }

    const response = { items, nextCursor };

    // ── 6. Cache (first page only) ────────────────────────────────────────────

    if (!cursorParam) {
      await redis.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });
    }

    return res.json(response);
  } catch (err) {
    console.error("TRENDING FEED ERROR:", err);
    return res.status(500).json({ error: "Trending feed failed" });
  }
});

export default router;
