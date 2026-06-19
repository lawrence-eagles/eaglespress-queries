import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/like", async (req, res) => {
  const { userId, postId, slug } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !postId || !slug) {
    return res.status(400).json({
      error: "Missing userId, postId, or slug",
    });
  }

  let isNewLike = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // 1. Insert like (idempotent)
      const likeResult = await tx.execute(sql`
        INSERT INTO likes (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      isNewLike = likeResult.rows.length > 0;

      if (!isNewLike) return;

      // 2. Get category safely from DB
      const categoryResult = await tx.execute(sql`
        SELECT category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      const categoryId = categoryResult.rows[0]?.category_id;

      // If post has no category, skip behavior update
      if (!categoryId) {
        // still update post counters
        await tx.execute(sql`
          UPDATE posts
          SET 
            likes_count = likes_count + 1,
            score = score + 5
          WHERE id = ${postId}
        `);

        return;
      }

      // 3. Update post counters
      await tx.execute(sql`
        UPDATE posts
        SET 
          likes_count = likes_count + 1,
          score = score + 5
        WHERE id = ${postId}
      `);

      // 4. ✅ Correct behavior update (already correct logic)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, 5)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 5
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (isNewLike) {
      const pipeline = redis.multi();

      // Version invalidation (O(1))
      pipeline.incr(`post:${slug}:version`);
      pipeline.incr(`feed:${userId}:version`);
      pipeline.incr(`feed:trending:version`);

      // Real-time counter
      pipeline.incr(`post:${postId}:likes`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      isNewLike,
    });
  } catch (err) {
    console.error("LIKE ERROR:", err);
    return res.status(500).json({ error: "Like failed" });
  }
});

export default router;
