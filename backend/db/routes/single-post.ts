// /routes/posts.ts

import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildPostCacheKey } from "@/utils/cache";

const router = Router();

// =========================
// 📊 TRACK CLICK (SAFE ASYNC)
// =========================
async function trackClick(
  postId: string,
  userId: string | null,
  categoryId: string | null,
) {
  try {
    await db.execute(sql`
      UPDATE posts
      SET 
        clicks = clicks + 1,
        score = score + 2
      WHERE id = ${postId}
    `);

    if (userId && categoryId) {
      await db.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, 2)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 2
      `);
    }
  } catch (err) {
    console.error("Tracking failed:", err);
  }
}

function trackClickAsync(
  postId: string,
  userId: string | null,
  categoryId: string | null,
) {
  void trackClick(postId, userId, categoryId);
}

// =========================
// 🚀 GET SINGLE POST
// =========================
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  const userId = (req.query.userId as string) || null;

  if (!slug) {
    return res.status(400).json({ error: "Missing slug" });
  }

  const cacheKey = buildPostCacheKey(slug);

  try {
    // =========================
    // 1. CACHE
    // =========================
    const cached = await redis.get(cacheKey);
    let basePost: any;

    if (cached) {
      basePost = JSON.parse(cached);
    } else {
      // =========================
      // 2. FETCH POST
      // =========================
      const result = await db.execute(sql`
        SELECT 
          p.id,
          p.title,
          p.slug,
          p.image_url,
          p.description,
          p.url,
          p.clicks,
          p.category_id,
          p.source_id,

          p.likes_count,
          p.comments_count,

          c.name as category_name,

          s.name as source_name,
          s.url as source_website

        FROM posts p

        LEFT JOIN categories c 
          ON p.category_id = c.id

        LEFT JOIN sources s
          ON p.source_id = s.id

        WHERE p.slug = ${slug}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Post not found" });
      }

      const p = result.rows[0];

      basePost = {
        id: p.id,
        title: p.title,
        slug: p.slug,
        imageUrl: p.image_url,
        summary: p.description,
        sourceUrl: p.url,

        category: p.category_name,
        categoryId: p.category_id,

        sourceName: p.source_name,
        sourceWebsite: p.source_website,

        likesCount: Number(p.likes_count) || 0,
        commentsCount: Number(p.comments_count) || 0,
      };

      // cache only base post
      if ((p.clicks ?? 0) > 10) {
        await redis.set(cacheKey, JSON.stringify(basePost), {
          EX: 300,
        });
      }
    }

    // =========================
    // 3. USER FLAGS
    // =========================
    let isLiked = false;
    let isBookmarked = false;
    let isFollowingCategory = false;

    if (userId) {
      const flags = await db.execute(sql`
        SELECT
          EXISTS (
            SELECT 1 FROM likes l
            WHERE l.post_id = ${basePost.id}
            AND l.user_id = ${userId}
          ) AS liked,

          EXISTS (
            SELECT 1 FROM bookmarks b
            WHERE b.post_id = ${basePost.id}
            AND b.user_id = ${userId}
          ) AS bookmarked,

          EXISTS (
            SELECT 1 FROM follows f
            WHERE f.category_id = ${basePost.categoryId}
            AND f.user_id = ${userId}
          ) AS following
      `);

      const f = flags.rows[0];

      // 🔥 SAFE BOOLEAN CAST
      isLiked = f?.liked === true || f?.liked === "t";
      isBookmarked = f?.bookmarked === true || f?.bookmarked === "t";
      isFollowingCategory = f?.following === true || f?.following === "t";
    }

    // =========================
    // 4. TRACK
    // =========================
    trackClickAsync(basePost.id, userId, basePost.categoryId);

    // =========================
    // 5. RESPONSE
    // =========================
    return res.json({
      ...basePost,
      isLiked,
      isBookmarked,
      isFollowingCategory,
    });
  } catch (err) {
    console.error("GET POST ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
