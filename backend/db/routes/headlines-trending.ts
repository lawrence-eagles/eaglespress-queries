import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

const PAGE_SIZE = 20;
const CACHE_TTL = 30; // shorter = fresher feed

// =========================
// 🔑 CURSOR (SAFE)
// =========================
type Cursor = {
  score: string; // 🔥 use string to avoid float issues
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
// 🔑 CACHE KEY (FIXED)
// =========================
function buildTrendingKey(cursor: string | null) {
  // only cache FIRST PAGE (critical)
  if (!cursor) return "feed:trending:first";

  return `feed:trending:cursor:${cursor}`;
}

// =========================
// 🚀 ROUTE
// =========================
router.get("/", async (req, res) => {
  try {
    const cursorParam = (req.query.cursor as string) || null;

    const cacheKey = buildTrendingKey(cursorParam);

    // =========================
    // 1. CACHE (ONLY FIRST PAGE)
    // =========================
    if (!cursorParam) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
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
    // 3. QUERY (INDEX-FRIENDLY)
    // =========================
    const query = sql`
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

        c.name as category_name,

        s.name as source_name,
        s.url as source_website,

        (
          (COALESCE(p.score, 0) * 3)
          - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
        ) AS trend_score

      FROM posts p

      LEFT JOIN categories c
        ON c.id = p.category_id

      LEFT JOIN sources s
        ON s.id = p.source_id

      ${
        cursor
          ? sql`
        WHERE (
          (
            (COALESCE(p.score, 0) * 3)
            - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
          ) < ${cursor.score}::float
          OR (
            (
              (COALESCE(p.score, 0) * 3)
              - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
            ) = ${cursor.score}::float
            AND p.created_at < ${cursor.createdAt}::timestamp
          )
          OR (
            (
              (COALESCE(p.score, 0) * 3)
              - EXTRACT(EPOCH FROM NOW() - COALESCE(p.created_at, NOW())) * 0.0001
            ) = ${cursor.score}::float
            AND p.created_at = ${cursor.createdAt}::timestamp
            AND p.id < ${cursor.id}::uuid
          )
        )
      `
          : sql``
      }

      ORDER BY
        trend_score DESC,
        p.created_at DESC,
        p.id DESC

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

      createdAt: new Date(p.created_at).toISOString(), // 🔥 normalize

      category: p.category_name,
      categoryId: p.category_id,

      sourceName: p.source_name,
      sourceWebsite: p.source_website,
    }));

    // =========================
    // 5. NEXT CURSOR (FIXED)
    // =========================
    let nextCursor: string | null = null;

    if (result.rows.length === PAGE_SIZE) {
      const last = result.rows[result.rows.length - 1];

      nextCursor = encodeCursor({
        score: String(last.trend_score), // 🔥 keep as string
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = {
      items,
      nextCursor,
    };

    // =========================
    // 6. CACHE (ONLY FIRST PAGE)
    // =========================
    if (!cursorParam) {
      await redis.set(cacheKey, JSON.stringify(response), {
        EX: CACHE_TTL,
      });
    }

    return res.json(response);
  } catch (err) {
    console.error("TRENDING FEED ERROR:", err);
    return res.status(500).json({ error: "Trending feed failed" });
  }
});

export default router;
