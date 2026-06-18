import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildFeedKey } from "@/utils/cache";

const router = Router();

const PAGE_SIZE = 20;

// ── Cursor ───────────────────────────────────────────────────────────────────

type Cursor = {
  score: string;
  createdAt: string;
  id: string;
};

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as Cursor;
}

// ── Row type ─────────────────────────────────────────────────────────────────

interface FeedRow {
  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  created_at: Date;
  category_id: string | null;
  source_id: string | null;
  likes_count: number | string;
  comments_count: number | string;
  category: string | null;
  source_name: string | null;
  source_url: string | null;
  rank_score: number | string;
  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

const rankingExpr = sql<number>`
(
  COALESCE(ub.score, 0) * 5 +
  COALESCE(p.score, 0) * 2 +
  CASE WHEN f.user_id IS NOT NULL THEN 3 ELSE 0 END -
  FLOOR(EXTRACT(EPOCH FROM NOW() - p.created_at)) * 0.0001
)
`;

// ── Route ────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const cursorParam = (req.query.cursor as string) || null;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // ✅ 1. Fetch versions ONCE (optimized)
    const [userVersion, globalVersion] = await Promise.all([
      redis.get(`feed:${userId}:version`),
      redis.get("feed:global:version"),
    ]);

    // ✅ 2. Use buildFeedKey (FIXED BUG)
    const cacheKey = await buildFeedKey(userId, cursorParam, {
      userVersion,
      globalVersion,
    });

    // ── 3. CACHE READ ───────────────────────────────────────────────────────

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // ── 4. DECODE CURSOR ────────────────────────────────────────────────────

    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // ── 5. QUERY ────────────────────────────────────────────────────────────

    const query = sql`
      WITH ranked_posts AS (
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
          c.name  AS category,
          s.name  AS source_name,
          s.url   AS source_url,
          ${rankingExpr} AS rank_score

        FROM posts p

        LEFT JOIN user_behavior ub
          ON ub.category_id = p.category_id
         AND ub.user_id = ${userId}

        LEFT JOIN follows f
          ON f.category_id = p.category_id
         AND f.user_id = ${userId}

        LEFT JOIN categories c
          ON c.id = p.category_id

        LEFT JOIN sources s
          ON s.id = p.source_id
      )

      SELECT
        rp.*,

        EXISTS (
          SELECT 1 FROM likes l
          WHERE l.post_id = rp.id AND l.user_id = ${userId}
        ) AS user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = rp.id AND b.user_id = ${userId}
        ) AS user_bookmarked

      FROM ranked_posts rp

      ${
        cursor
          ? sql`
        WHERE (
          rp.rank_score < ${cursor.score}::float
          OR (
            rp.rank_score = ${cursor.score}::float
            AND rp.created_at < ${cursor.createdAt}::timestamp
          )
          OR (
            rp.rank_score = ${cursor.score}::float
            AND rp.created_at = ${cursor.createdAt}::timestamp
            AND rp.id < ${cursor.id}::uuid
          )
        )
      `
          : sql``
      }

      ORDER BY
        rp.rank_score DESC,
        rp.created_at DESC,
        rp.id DESC

      LIMIT ${PAGE_SIZE}
    `;

    const result = await db.execute(query);
    const rows = result.rows as FeedRow[];

    // ── 6. MAP ─────────────────────────────────────────────────────────────

    const items = rows.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.image_url,
      summary: p.description,
      sourceUrl: p.url,
      createdAt: new Date(p.created_at).toISOString(),

      category: p.category,
      categoryId: p.category_id,

      sourceName: p.source_name,
      sourceWebsite: p.source_url,

      likesCount: Number(p.likes_count) || 0,
      commentsCount: Number(p.comments_count) || 0,

      isLiked: p.user_liked === true || p.user_liked === "t",
      isBookmarked: p.user_bookmarked === true || p.user_bookmarked === "t",
    }));

    // ── 7. CURSOR ───────────────────────────────────────────────────────────

    let nextCursor: string | null = null;

    if (rows.length === PAGE_SIZE) {
      const last = rows[rows.length - 1];

      nextCursor = encodeCursor({
        score: String(last.rank_score),
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // ── 8. CACHE WRITE ──────────────────────────────────────────────────────

    await redis.set(cacheKey, JSON.stringify(response), { EX: 30 });

    return res.json(response);
  } catch (err) {
    console.error("FEED ERROR:", err);
    return res.status(500).json({ error: "Feed failed" });
  }
});

export default router;
