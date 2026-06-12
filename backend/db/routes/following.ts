// FOLLOWING FEED ROUTE (following.ts) THIS IS THE CODE TO USE FOR THE FOLLOWING SECTION
// /routes/following.ts
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
// 🔑 CACHE KEY
// =========================
function buildFollowingKey(userId: string, cursor: string | null) {
  return `feed:following:${userId}:${cursor ?? "start"}`;
}

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

    const cacheKey = buildFollowingKey(userId, cursorParam);

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
    // 3. QUERY (FIXED)
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
        s.url as source_website

      FROM posts p

      -- ✅ FIXED: correct join
      JOIN follows f 
        ON f.category_id = p.category_id
        AND f.user_id = ${userId}

      LEFT JOIN categories c
        ON c.id = p.category_id

      LEFT JOIN sources s
        ON s.id = p.source_id

      ${
        cursor
          ? sql`
        WHERE (
          p.created_at < ${cursor.createdAt}
          OR (
            p.created_at = ${cursor.createdAt}
            AND p.id < ${cursor.id}
          )
        )
      `
          : sql``
      }

      ORDER BY 
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

      createdAt: p.created_at,

      category: p.category_name,
      categoryId: p.category_id,

      // ✅ NEW
      sourceName: p.source_name,
      sourceWebsite: p.source_website,
    }));

    // =========================
    // 5. NEXT CURSOR
    // =========================
    let nextCursor: string | null = null;

    if (result.rows.length > 0) {
      const last = result.rows[result.rows.length - 1];

      nextCursor = encodeCursor({
        createdAt: last.created_at,
        id: last.id,
      });
    }

    const response = {
      items,
      nextCursor,
    };

    // =========================
    // 6. CACHE
    // =========================
    await redis.set(cacheKey, JSON.stringify(response), {
      EX: 60,
    });

    return res.json(response);
  } catch (err) {
    console.error("FOLLOWING FEED ERROR:", err);
    return res.status(500).json({ error: "Following feed failed" });
  }
});

export default router;
