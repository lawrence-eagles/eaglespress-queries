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
      const deleteResult = await tx.execute(sql`
        DELETE FROM likes
        WHERE user_id = ${userId} AND post_id = ${postId}
        RETURNING 1
      `);

      isRemoved = deleteResult.rows.length > 0;

      if (!isRemoved) return;

      // Update post safely
      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = GREATEST(likes_count - 1, 0),
          score = score - 5
        WHERE id = ${postId}
      `);

      // Update user behavior
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, -5)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score - 5
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

      // Optional safety: prevent negative values (rare edge case)
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
