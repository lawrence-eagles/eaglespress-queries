// FEED PERSONALIZATION ("FOR YOU") SECTION WITH CUSOR BASED PAGINATION
// PRODUCTION READY FINAL VERSION WITH BUG FIXES FOR CATEGORY ID AND USER_BEHAVIOR ID
// /routes/feed.ts

// /routes/feed.ts

import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

const PAGE_SIZE = 20;

// =========================
// 🔑 CURSOR
// =========================
type Cursor = {
  score: number;
  createdAt: string;
};

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): Cursor {
  return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
}

// =========================
// 🔑 CACHE KEY
// =========================
function buildFeedKey(userId: string, cursor: string | null) {
  return `feed:for-you:${userId}:${cursor ?? "start"}`;
}

// =========================
// 📊 RANKING (STABLE)
// =========================
const rankingExpr = sql`
(
  COALESCE(ub.score, 0) * 5 +
  COALESCE(p.score, 0) * 2 -
  EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
)
`;

// =========================
// 🚀 FEED ROUTE
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
    // 3. QUERY (FULLY FIXED)
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

          c.name as category,
          s.name as source_name,
          s.url as source_url,

          ${rankingExpr} AS rank_score

        FROM posts p

        LEFT JOIN user_behavior ub
          ON ub.category_id = p.category_id
          AND ub.user_id = ${userId}

        LEFT JOIN categories c
          ON c.id = p.category_id

        LEFT JOIN sources s
          ON s.id = p.source_id
      )

      SELECT *
      FROM ranked_posts
      ${
        cursor
          ? sql`
        WHERE
          (
            rank_score < ${cursor.score}
            OR (
              rank_score = ${cursor.score}
              AND created_at < ${cursor.createdAt}
            )
          )
      `
          : sql``
      }

      ORDER BY
        rank_score DESC,
        created_at DESC

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

      // ✅ NEW
      sourceName: p.source_name,
      sourceWebsite: p.source_url,
    }));

    // =========================
    // 5. NEXT CURSOR
    // =========================
    let nextCursor: string | null = null;

    if (result.rows.length === PAGE_SIZE) {
      const last = result.rows[result.rows.length - 1];

      nextCursor = encodeCursor({
        score: Number(last.rank_score),
        createdAt: last.created_at,
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
      EX: 60,
    });

    return res.json(response);
  } catch (err) {
    console.error("FEED ERROR:", err);
    return res.status(500).json({ error: "Feed failed" });
  }
});

export default router;
