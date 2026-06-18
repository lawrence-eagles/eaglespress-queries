import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.delete("/api/bookmark", async (req, res) => {
  const { userId, postId, slug } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !postId || !slug) {
    return res.status(400).json({
      error: "Missing userId, postId, or slug",
    });
  }

  let wasDeleted = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // 1. Delete bookmark (idempotent)
      const result = await tx.execute(sql`
        DELETE FROM bookmarks
        WHERE user_id = ${userId}
          AND post_id = ${postId}
        RETURNING 1
      `);

      wasDeleted = result.rows.length > 0;

      if (!wasDeleted) return;

      // 2. Decrease post score (-8, CLAMPED)
      await tx.execute(sql`
        UPDATE posts
        SET score = GREATEST(score - 8, 0)
        WHERE id = ${postId}
      `);

      // 3. Decrease user behavior (-8, CLAMPED + GUARDED)
      await tx.execute(sql`
        UPDATE user_behavior ub
        SET score = GREATEST(ub.score - 8, 0)
        FROM posts p
        WHERE p.id = ${postId}
          AND p.category_id IS NOT NULL
          AND ub.user_id = ${userId}
          AND ub.category_id = p.category_id
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (wasDeleted) {
      const pipeline = redis.multi();

      // 🔥 Invalidate user's bookmarks feed
      pipeline.incr(`bookmarks:${userId}:version`);

      // 🔥 Invalidate post cache
      pipeline.incr(`post:${slug}:version`);

      // 🔥 Invalidate personalized feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      wasDeleted,
    });
  } catch (err) {
    console.error("UNBOOKMARK ERROR:", err);
    return res.status(500).json({ error: "Unbookmark failed" });
  }
});

export default router;
