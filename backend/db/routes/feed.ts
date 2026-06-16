import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

const PAGE_SIZE = 20;

// =========================
// 🔑 CURSOR (STABLE)
// =========================
type Cursor = {
  score: number;
  createdAt: string;
  id: string;
};

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): Cursor {
  return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

// =========================
// 🔑 CACHE KEY (IMPROVED)
// =========================
function buildFeedKey(userId: string, cursor: string | null) {
  return cursor ? `feed:${userId}:cursor:${cursor}` : `feed:${userId}:start`;
}

// =========================
// 📊 RANKING (FIXED PRECISION)
// =========================
const rankingExpr = sql<number>`
(
  COALESCE(ub.score, 0) * 5 +
  COALESCE(p.score, 0) * 2 +
  CASE WHEN f.user_id IS NOT NULL THEN 3 ELSE 0 END -
  FLOOR(EXTRACT(EPOCH FROM NOW() - p.created_at)) * 0.0001
)
`;

// =========================
// 🚀 ROUTE
// =========================
router.get("/", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const cursorParam = req.query.cursor as string | null;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const cacheKey = buildFeedKey(userId, cursorParam);

    // =========================
    // 1. CACHE
    // =========================
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // =========================
    // 2. CURSOR
    // =========================
    let cursor: Cursor | null = null;

    if (cursorParam) {
      try {
        cursor = decodeCursor(cursorParam);
      } catch {
        return res.status(400).json({ error: "Invalid cursor" });
      }
    }

    // =========================
    // 3. QUERY (OPTIMIZED)
    // =========================
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

          c.name as category,
          s.name as source_name,
          s.url as source_url,

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
        ) as user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = rp.id AND b.user_id = ${userId}
        ) as user_bookmarked

      FROM ranked_posts rp

      ${
        cursor
          ? sql`
        WHERE (
          rp.rank_score < ${cursor.score}
          OR (
            rp.rank_score = ${cursor.score}
            AND rp.created_at < ${cursor.createdAt}::timestamp
          )
          OR (
            rp.rank_score = ${cursor.score}
            AND rp.created_at = ${cursor.createdAt}::timestamp
            AND rp.id < ${cursor.id}
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

    // =========================
    // 4. MAP RESPONSE
    // =========================
    const items = result.rows.map((p: any) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.image_url,
      summary: p.description,
      sourceUrl: p.url,
      createdAt: p.created_at,

      category: p.category,
      categoryId: p.category_id,

      sourceName: p.source_name,
      sourceWebsite: p.source_url,

      likesCount: Number(p.likes_count) || 0,
      commentsCount: Number(p.comments_count) || 0,

      isLiked: p.user_liked,
      isBookmarked: p.user_bookmarked,
    }));

    // =========================
    // 5. NEXT CURSOR (FIXED)
    // =========================
    let nextCursor: string | null = null;

    if (result.rows.length === PAGE_SIZE) {
      const last = result.rows[result.rows.length - 1];

      nextCursor = encodeCursor({
        score: Number(last.rank_score),
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = {
      items,
      nextCursor,
    };

    // =========================
    // 6. CACHE (SHORT TTL)
    // =========================
    await redis.set(cacheKey, JSON.stringify(response), {
      EX: 30, // 🔥 shorter = fresher feed
    });

    return res.json(response);
  } catch (err) {
    console.error("FEED ERROR:", err);
    return res.status(500).json({ error: "Feed failed" });
  }
});

export default router;
