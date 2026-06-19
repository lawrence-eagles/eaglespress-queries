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
      // ✅ 1. Ensure category EXISTS (DO NOT trust client blindly)
      const categoryResult = await tx.execute(sql`
        SELECT id FROM categories
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid category");
      }

      const validCategoryId = categoryResult.rows[0].id;

      // ✅ 2. Insert follow safely
      const result = await tx.execute(sql`
        INSERT INTO follows (user_id, category_id)
        VALUES (${userId}, ${validCategoryId})
        ON CONFLICT (user_id, category_id) DO NOTHING
        RETURNING 1
      `);

      isNewFollow = result.rows.length > 0;

      if (!isNewFollow) return;

      // ✅ 3. Update user behavior (SAFE increment, no overwrite bug)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${validCategoryId}, 10)
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

      // Invalidate following feed
      pipeline.incr(`following:${userId}:version`);

      // Invalidate personalized feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      isNewFollow,
    });
  } catch (err) {
    console.error("FOLLOW CATEGORY ERROR:", err);

    // ✅ Better error handling
    if (err instanceof Error && err.message === "Invalid category") {
      return res.status(400).json({ error: "Invalid categoryId" });
    }

    return res.status(500).json({ error: "Follow category failed" });
  }
});

export default router;
