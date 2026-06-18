import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";

const router = Router();

router.post("/api/bookmark", async (req, res) => {
  const { userId, postId, slug } = req.body;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || !postId || !slug) {
    return res.status(400).json({
      error: "Missing userId, postId, or slug",
    });
  }

  let isNewBookmark = false;

  try {
    // =========================
    // 2. TRANSACTION
    // =========================
    await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO bookmarks (user_id, post_id)
        VALUES (${userId}, ${postId})
        ON CONFLICT (user_id, post_id) DO NOTHING
        RETURNING 1
      `);

      isNewBookmark = result.rows.length > 0;

      if (!isNewBookmark) return;
    });

    // =========================
    // 3. REDIS INVALIDATION (PIPELINED)
    // =========================
    if (isNewBookmark) {
      const pipeline = redis.multi();

      // 🔥 Invalidate user's bookmarks feed
      pipeline.incr(`bookmarks:${userId}:version`);

      // 🔥 Invalidate post cache (bookmark state may be embedded)
      pipeline.incr(`post:${slug}:version`);

      // 🔥 Invalidate user's main feed (if bookmarks affect UI state)
      pipeline.incr(`feed:${userId}:version`);

      await pipeline.exec();
    }

    return res.json({
      success: true,
      isNewBookmark,
    });
  } catch (err) {
    console.error("BOOKMARK ERROR:", err);
    return res.status(500).json({ error: "Bookmark failed" });
  }
});

export default router;
