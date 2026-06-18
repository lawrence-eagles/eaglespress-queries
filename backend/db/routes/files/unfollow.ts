import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/unfollow-category", async (req, res) => {
  const { userId, categoryId } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !categoryId) {
    return res.status(400).json({
      error: "Missing userId or categoryId",
    });
  }

  let wasUnfollowed = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        DELETE FROM follows
        WHERE user_id = ${userId}
        AND category_id = ${categoryId}
        RETURNING 1
      `);

      wasUnfollowed = result.rows.length > 0;

      if (!wasUnfollowed) return;

      // 🔥 Optional: reduce user behavior (keeps personalization accurate)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, -10)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score - 10
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (wasUnfollowed) {
      const pipeline = redis.multi();

      // 🔥 Invalidate following feed
      pipeline.incr(`following:${userId}:version`);

      // 🔥 Invalidate personalized main feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      wasUnfollowed,
    });
  } catch (err) {
    console.error("UNFOLLOW CATEGORY ERROR:", err);
    return res.status(500).json({ error: "Unfollow category failed" });
  }
});

export default router;
