// NOTE THIS REDIS SETUP IS GLOBAL
// NOTE THE REDIS SETUP BELOW IS GLOBAL
// /lib/redis.ts Redis setup
import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL,
});

await redis.connect();

// BUILD CACHE KEY FUNCTION
// /utils/cache.ts
/**
 * Build Redis cache key for single post
 */
export function buildPostCacheKey(slug: string) {
  return `post:${slug}`;
}

// EXPRESS ROUTER FOR SINGLE POST FINAL VERSION WITH BUG FIXES FOR CATEGORRY ID AND USER_BEHAVIOR ID
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

// fire-and-forget wrapper (prevents unhandled rejection)
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

    if (cached) {
      const post = JSON.parse(cached);

      trackClickAsync(post.id, userId, post.categoryId);

      return res.json(post);
    }

    // =========================
    // 2. FETCH POST (FIXED JOIN)
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

    // =========================
    // 3. RESPONSE (UPDATED)
    // =========================
    const response = {
      id: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.image_url,
      summary: p.description,
      sourceUrl: p.url, // article URL

      category: p.category_name,
      categoryId: p.category_id,

      // ✅ NEW FIELDS
      sourceName: p.source_name,
      sourceWebsite: p.source_website,
    };

    // =========================
    // 4. CACHE HOT POSTS
    // =========================
    if ((p.clicks ?? 0) > 10) {
      await redis.set(cacheKey, JSON.stringify(response), {
        EX: 300,
      });
    }

    // =========================
    // 5. TRACK (SAFE)
    // =========================
    trackClickAsync(p.id, userId, p.category_id);

    return res.json(response);
  } catch (err) {
    console.error("GET POST ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
