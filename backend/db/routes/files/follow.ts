import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/follow-category", async (req, res) => {
  const { userId, categoryId } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !categoryId) {
    return res.status(400).json({
      error: "Missing userId or categoryId",
    });
  }

  let isNewFollow = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO follows (user_id, category_id)
        VALUES (${userId}, ${categoryId})
        ON CONFLICT (user_id, category_id) DO NOTHING
        RETURNING 1
      `);

      isNewFollow = result.rows.length > 0;

      if (!isNewFollow) return;

      // 🔥 Optional: boost user behavior (recommended for personalization)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, 10)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 10
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (isNewFollow) {
      const pipeline = redis.multi();

      // 🔥 Invalidate following feed
      pipeline.incr(`following:${userId}:version`);

      // 🔥 Invalidate personalized main feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      isNewFollow,
    });
  } catch (err) {
    console.error("FOLLOW CATEGORY ERROR:", err);
    return res.status(500).json({ error: "Follow category failed" });
  }
});

export default router;
