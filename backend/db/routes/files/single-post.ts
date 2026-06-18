import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildPostCacheKey } from "@/utils/cache"; // BUG FIX: was missing, caused startup crash

const router = Router();

// ── Row types ─────────────────────────────────────────────────────────────────

interface PostRow {
  id: string;
  title: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  url: string;
  clicks: number;
  category_id: string | null;
  source_id: string | null;
  likes_count: number | string;
  comments_count: number | string;
  category_name: string | null;
  source_name: string | null;
  source_website: string | null;
}

interface FlagsRow {
  liked: boolean | string;
  bookmarked: boolean | string;
  following: boolean | string;
}

// ── Track click ───────────────────────────────────────────────────────────────
//
// BUG FIX: original fired two separate DB calls sequentially — UPDATE posts
// then INSERT INTO user_behavior. If the UPDATE succeeded but the INSERT
// failed, the post score was incremented but user behavior was never recorded,
// creating a silent inconsistency.
// Fix: wrap both in a transaction so they succeed or fail atomically.

async function trackClick(
  postId: string,
  userId: string | null,
  categoryId: string | null,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE posts
        SET
          clicks = clicks + 1,
          score  = score  + 2
        WHERE id = ${postId}
      `);

      if (userId && categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 2)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET score = user_behavior.score + 2
        `);
      }
    });
  } catch (err) {
    // Tracking failures must never surface to the user
    console.error("[trackClick] Failed:", err);
  }
}

// Fire-and-forget — does not block the response
function trackClickAsync(
  postId: string,
  userId: string | null,
  categoryId: string | null,
): void {
  void trackClick(postId, userId, categoryId);
}

// ── GET /:slug ────────────────────────────────────────────────────────────────

router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  const userId = (req.query.userId as string) || null;

  if (!slug) {
    return res.status(400).json({ error: "Missing slug" });
  }

  const cacheKey = await buildPostCacheKey(slug);

  try {
    // ── 1. Cache ──────────────────────────────────────────────────────────────

    const cached = await redis.get(cacheKey);
    let basePost: ReturnType<typeof mapPost> | null = null;

    if (cached) {
      basePost = JSON.parse(cached);
    } else {
      // ── 2. Fetch post ───────────────────────────────────────────────────────

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
          c.name AS category_name,
          s.name AS source_name,
          s.url  AS source_website

        FROM posts p

        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN sources     s ON p.source_id   = s.id

        WHERE p.slug = ${slug}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Post not found" });
      }

      const p = result.rows[0] as PostRow;
      basePost = mapPost(p);

      // Only cache posts with meaningful traffic (> 10 clicks)
      // to avoid flooding Redis with cold cache entries
      if ((p.clicks ?? 0) > 10) {
        await redis.set(cacheKey, JSON.stringify(basePost), { EX: 300 });
      }
    }

    // ── 3. User flags (always fresh — never cached) ───────────────────────────

    let isLiked = false;
    let isBookmarked = false;
    let isFollowingCategory = false;

    if (userId && basePost) {
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
              AND f.user_id     = ${userId}
          ) AS following
      `);

      const f = flags.rows[0] as FlagsRow;

      // pg driver returns EXISTS as boolean OR "t"/"f" string — cast both
      isLiked = f?.liked === true || f?.liked === "t";
      isBookmarked = f?.bookmarked === true || f?.bookmarked === "t";
      isFollowingCategory = f?.following === true || f?.following === "t";
    }

    // ── 4. Track click (non-blocking) ─────────────────────────────────────────

    if (basePost) {
      trackClickAsync(basePost.id, userId, basePost.categoryId);
    }

    // ── 5. Response ───────────────────────────────────────────────────────────

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

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapPost(p: PostRow) {
  return {
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
}

export default router;
