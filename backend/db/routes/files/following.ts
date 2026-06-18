// /routes/following.ts
// Feed of posts from categories the user follows.
//
// BUG FIX 1: File was named headlines.ts — completely wrong name.
//            The route implements a following feed (JOIN on follows table).
//            Renamed to following.ts to match its actual purpose.
//
// BUG FIX 2: nextCursor was generated when result.rows.length > 0.
//            This returns a cursor on the final partial page, causing clients
//            to make one extra request that returns zero results.
//            Fixed to: result.rows.length === PAGE_SIZE (consistent with all
//            other routes).
//
// BUG FIX 3: result.rows.map((p: any) => ...) — no row type.
//            Added FollowingRow interface for compile-time safety.
//
// BUG FIX 4: createdAt: p.created_at — raw Date object in JSON response.
//            Fixed to: new Date(p.created_at).toISOString()
//
// BUG FIX 5: nextCursor used raw last.created_at instead of ISO string.
//            Fixed to: new Date(last.created_at).toISOString()
//
// BUG FIX 6: isLiked and isBookmarked missing from query and response.
//            Added EXISTS subqueries and boolean casts — consistent with
//            every other feed endpoint.
//
// BUG FIX 7: likesCount and commentsCount missing from query and response.
//            Added p.likes_count, p.comments_count to SELECT and map.

import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildFollowingKey } from "@/utils/cache";

const router = Router();

const PAGE_SIZE = 20;

// ── Cursor ────────────────────────────────────────────────────────────────────

type Cursor = {
  createdAt: string;
  id: string;
};

// BUG FIX 9 (from bookmark.ts pattern): use base64url — standard base64
// contains +, /, = characters that are not URL-safe in query parameters.
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as Cursor;
}

// ── Row type ──────────────────────────────────────────────────────────────────
// BUG FIX 3: was `any` — replaced with typed interface.

interface FollowingRow {
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
  // BUG FIX 7: was missing
  likes_count: number | string;
  comments_count: number | string;
  // BUG FIX 6: was missing
  user_liked: boolean | string;
  user_bookmarked: boolean | string;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const cursorParam = (req.query.cursor as string) || null;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const cacheKey = await buildFollowingKey(userId, cursorParam);

    // ── 1. Cache ──────────────────────────────────────────────────────────────

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // ── 2. Cursor ─────────────────────────────────────────────────────────────

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

        EXISTS (
          SELECT 1 FROM likes l
          WHERE l.post_id = p.id
            AND l.user_id = ${userId}
        ) AS user_liked,

        EXISTS (
          SELECT 1 FROM bookmarks b
          WHERE b.post_id = p.id
            AND b.user_id = ${userId}
        ) AS user_bookmarked

      FROM posts p

      JOIN follows f
        ON f.category_id = p.category_id
       AND f.user_id = ${userId}

      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sources     s ON s.id = p.source_id

      ${
        cursor
          ? sql`
        WHERE (
          p.created_at < ${cursor.createdAt}::timestamp
          OR (
            p.created_at = ${cursor.createdAt}::timestamp
            AND p.id < ${cursor.id}::uuid
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
    const rows = result.rows as FollowingRow[];

    // ── 4. Map response ───────────────────────────────────────────────────────

    const items = rows.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,

      imageUrl: p.image_url,
      summary: p.description,
      sourceUrl: p.url,

      // BUG FIX 4: was raw p.created_at — must be ISO string
      createdAt: new Date(p.created_at).toISOString(),

      category: p.category_name,
      categoryId: p.category_id,

      sourceName: p.source_name,
      sourceWebsite: p.source_website,

      // BUG FIX 7: was missing
      likesCount: Number(p.likes_count) || 0,
      commentsCount: Number(p.comments_count) || 0,

      // BUG FIX 6: was missing — pg returns EXISTS as boolean or "t"/"f" string
      isLiked: p.user_liked === true || p.user_liked === "t",
      isBookmarked: p.user_bookmarked === true || p.user_bookmarked === "t",
    }));

    // ── 5. Next cursor ────────────────────────────────────────────────────────
    //
    // BUG FIX 2: was `result.rows.length > 0` — generates cursor on last page,
    // causing clients to make an extra empty request.
    // Fixed to === PAGE_SIZE: cursor only when a full page was returned.

    let nextCursor: string | null = null;

    if (rows.length === PAGE_SIZE) {
      const last = rows[rows.length - 1];

      nextCursor = encodeCursor({
        // BUG FIX 5: was raw last.created_at — must be ISO string
        createdAt: new Date(last.created_at).toISOString(),
        id: last.id,
      });
    }

    const response = { items, nextCursor };

    // ── 6. Cache ──────────────────────────────────────────────────────────────

    await redis.set(cacheKey, JSON.stringify(response), { EX: 60 });

    return res.json(response);
  } catch (err) {
    console.error("FOLLOWING FEED ERROR:", err);
    return res.status(500).json({ error: "Following feed failed" });
  }
});

export default router;
