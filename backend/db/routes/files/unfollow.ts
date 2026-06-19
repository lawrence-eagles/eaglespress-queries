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
      // ✅ 1. VERIFY CATEGORY EXISTS
      const categoryResult = await tx.execute(sql`
        SELECT id 
        FROM categories 
        WHERE id = ${categoryId}
        LIMIT 1
      `);

      if (categoryResult.rows.length === 0) {
        throw new Error("Invalid categoryId");
      }

      // ✅ SAFE SOURCE OF TRUTH
      const validCategoryId = categoryResult.rows[0].id;

      // ✅ 2. DELETE FOLLOW (USE VALID ID)
      const deleteResult = await tx.execute(sql`
        DELETE FROM follows
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
        RETURNING 1
      `);

      wasUnfollowed = deleteResult.rows.length > 0;

      if (!wasUnfollowed) return;

      // ✅ 3. UPDATE USER BEHAVIOR (USE VALID ID)
      await tx.execute(sql`
        UPDATE user_behavior
        SET score = GREATEST(score - 10, 1)
        WHERE user_id = ${userId}
          AND category_id = ${validCategoryId}
      `);
    });

    // =========================
    // 3. REDIS INVALIDATION
    // =========================
    if (wasUnfollowed) {
      const pipeline = redis.multi();

      pipeline.incr(`following:${userId}:version`);
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      wasUnfollowed,
    });
  } catch (err) {
    console.error("UNFOLLOW CATEGORY ERROR:", err);

    if ((err as Error).message === "Invalid categoryId") {
      return res.status(400).json({ error: "Invalid categoryId" });
    }

    return res.status(500).json({
      error: "Unfollow category failed",
    });
  }
});

export default router;
