import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/unlike", async (req, res) => {
  const { userId, postId, categoryId, slug } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !postId || !categoryId || !slug) {
    return res.status(400).json({
      error: "Missing userId, postId, categoryId, or slug",
    });
  }

  let isRemoved = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // 1. Delete like (idempotent)
      const deleteResult = await tx.execute(sql`
        DELETE FROM likes
        WHERE user_id = ${userId}
          AND post_id = ${postId}
        RETURNING 1
      `);

      isRemoved = deleteResult.rows.length > 0;

      if (!isRemoved) return;

      // 2. Update post safely (never below 0)
      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = GREATEST(likes_count - 1, 0),
          score = GREATEST(score - 5, 0)
        WHERE id = ${postId}
      `);

      // 3. ✅ FIXED: Only update existing behavior (no insert)
      await tx.execute(sql`
        UPDATE user_behavior
        SET score = GREATEST(score - 5, 1)
        WHERE user_id = ${userId}
          AND category_id = ${categoryId}
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (isRemoved) {
      const pipeline = redis.multi();

      // Version invalidation (O(1))
      pipeline.incr(`post:${slug}:version`);
      pipeline.incr(`feed:${userId}:version`);
      pipeline.incr(`feed:trending:version`);

      // Atomic decrement
      pipeline.decr(`post:${postId}:likes`);

      await pipeline.exec();

      // Safety guard (rare edge case)
      const likes = await redis.get(`post:${postId}:likes`);
      if (likes && parseInt(likes, 10) < 0) {
        await redis.set(`post:${postId}:likes`, 0);
      }
    }

    return res.json({
      success: true,
      isRemoved,
    });
  } catch (err) {
    console.error("UNLIKE ERROR:", err);
    return res.status(500).json({ error: "Unlike failed" });
  }
});

export default router;
