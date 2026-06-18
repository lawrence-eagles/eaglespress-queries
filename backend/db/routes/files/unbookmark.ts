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
      const result = await tx.execute(sql`
        DELETE FROM bookmarks
        WHERE user_id = ${userId}
        AND post_id = ${postId}
        RETURNING 1
      `);

      wasDeleted = result.rows.length > 0;

      if (!wasDeleted) return;
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (wasDeleted) {
      const pipeline = redis.multi();

      // 🔥 Invalidate user's bookmarks feed
      pipeline.incr(`bookmarks:${userId}:version`);

      // 🔥 Invalidate post cache (bookmark state embedded)
      pipeline.incr(`post:${slug}:version`);

      // 🔥 Invalidate user's main feed
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
