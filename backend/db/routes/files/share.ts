import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/share-post", async (req, res) => {
  const { userId, postId } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !postId) {
    return res.status(400).json({
      error: "Missing userId or postId",
    });
  }

  let didShare = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      // ✅ 1. GET POST + CATEGORY (DO NOT TRUST CLIENT)
      const postResult = await tx.execute(sql`
        SELECT id, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (postResult.rows.length === 0) {
        throw new Error("Invalid postId");
      }

      const validPostId = postResult.rows[0].id;
      const categoryId = postResult.rows[0].category_id;

      // If post has no category → skip behavior update
      // (safe guard for nullable categoryId)
      if (!categoryId) {
        didShare = true;
        return;
      }

      // ✅ 2. UPDATE USER BEHAVIOR (+5)
      await tx.execute(sql`
        INSERT INTO user_behavior (user_id, category_id, score)
        VALUES (${userId}, ${categoryId}, 5)
        ON CONFLICT (user_id, category_id)
        DO UPDATE SET 
          score = user_behavior.score + 5
      `);

      // ✅ 3. OPTIONAL: BOOST POST SCORE (recommended for ranking)
      await tx.execute(sql`
        UPDATE posts
        SET score = score + 5
        WHERE id = ${validPostId}
      `);

      didShare = true;
    });

    // =========================
    // 3. REDIS INVALIDATION
    // =========================
    if (didShare) {
      const pipeline = redis.multi();

      // ✅ Only invalidate personalized feed
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      didShare,
    });
  } catch (err) {
    console.error("SHARE POST ERROR:", err);

    if ((err as Error).message === "Invalid postId") {
      return res.status(400).json({ error: "Invalid postId" });
    }

    return res.status(500).json({
      error: "Share post failed",
    });
  }
});

export default router;
