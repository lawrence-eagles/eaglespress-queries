import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildCommentsKey } from "@/utils/cache";

const router = Router();

// =========================
// CONFIG
// =========================
const PAGE_SIZE = 10;
const CACHE_TTL = 60;
const MAX_COMMENT_LENGTH = 2000;

// =========================
// RATE LIMITER (atomic)
// =========================
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 15;

async function rateLimit(userId: string, action: string) {
  const key = `rate:${action}:${userId}`;

  const tx = redis.multi();
  tx.incr(key);
  tx.expire(key, RATE_LIMIT_WINDOW);
  const [count] = await tx.exec();

  if ((count as number) > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// =========================
// CURSOR HELPERS
// =========================
function encodeCursor(data: any) {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

function decodeCursor(cursor: string) {
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
  } catch {
    throw new Error("Invalid cursor");
  }
}

// =========================
// 1. CREATE COMMENT
// =========================
router.post("/api/comments", async (req, res) => {
  const { userId, postId, content, parentId } = req.body;

  if (!userId || !postId || !content) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (content.length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ error: "Comment too long" });
  }

  let createdComment: any;
  let slug: string;
  let categoryId: string;

  try {
    await rateLimit(userId, "create_comment");

    await db.transaction(async (tx) => {
      const post = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
        LIMIT 1
      `);

      if (post.rows.length === 0) throw new Error("Invalid post");

      slug = post.rows[0].slug;
      categoryId = post.rows[0].category_id;

      const insert = await tx.execute(sql`
        INSERT INTO comments (content, user_id, post_id, parent_id)
        VALUES (${content}, ${userId}, ${postId}, ${parentId ?? null})
        RETURNING *
      `);

      createdComment = insert.rows[0];

      await tx.execute(sql`
        UPDATE posts
        SET score = score + 7,
            comments_count = comments_count + 1
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          INSERT INTO user_behavior (user_id, category_id, score)
          VALUES (${userId}, ${categoryId}, 7)
          ON CONFLICT (user_id, category_id)
          DO UPDATE SET score = user_behavior.score + 7
        `);
      }
    });

    const pipe = redis.multi();
    pipe.incr(`comments:${postId}:version`);
    pipe.incr(`post:${slug}:version`);
    pipe.incr(`feed:${userId}:version`);
    pipe.incr(`feed:trending:version`);
    await pipe.exec();

    return res.json({ success: true, comment: createdComment });
  } catch (err: any) {
    if (err.message.includes("Too many")) {
      return res.status(429).json({ error: err.message });
    }

    console.error(err);
    return res.status(500).json({ error: "Create failed" });
  }
});

// =========================
// 2. UPDATE COMMENT
// =========================
router.put("/api/comments/:id", async (req, res) => {
  const { id } = req.params;
  const { userId, content } = req.body;

  if (!id || !userId || !content) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    await rateLimit(userId, "update_comment");

    const result = await db.execute(sql`
      UPDATE comments
      SET content = ${content}
      WHERE id = ${id}
        AND user_id = ${userId}
      RETURNING post_id
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const postId = result.rows[0].post_id;

    const pipe = redis.multi();
    pipe.incr(`comments:${postId}:version`);
    pipe.incr(`feed:${userId}:version`);
    await pipe.exec();

    return res.json({ success: true });
  } catch (err: any) {
    if (err.message.includes("Too many")) {
      return res.status(429).json({ error: err.message });
    }

    console.error(err);
    return res.status(500).json({ error: "Update failed" });
  }
});

// =========================
// 3. DELETE COMMENT
// =========================
router.delete("/api/comments/:id", async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  if (!id || !userId) {
    return res.status(400).json({ error: "Missing fields" });
  }

  let postId: string | null = null;
  let slug: string | null = null;
  let categoryId: string | null = null;

  try {
    await rateLimit(userId, "delete_comment");

    await db.transaction(async (tx) => {
      const comment = await tx.execute(sql`
        SELECT post_id
        FROM comments
        WHERE id = ${id}
          AND user_id = ${userId}
      `);

      if (comment.rows.length === 0) return;

      postId = comment.rows[0].post_id;

      const post = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
      `);

      slug = post.rows[0].slug;
      categoryId = post.rows[0].category_id;

      await tx.execute(sql`DELETE FROM comments WHERE id = ${id}`);

      await tx.execute(sql`
        UPDATE posts
        SET score = GREATEST(score - 7, 0),
            comments_count = GREATEST(comments_count - 1, 0)
        WHERE id = ${postId}
      `);

      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 7, 1)
          WHERE user_id = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // if (!postId) {
    //   return res.json({ success: true });
    // }

    if (!postId) {
      return res.json({
        success: true,
        deleted: false,
      });
    }

    const pipe = redis.multi();
    pipe.incr(`comments:${postId}:version`);
    pipe.incr(`post:${slug}:version`);
    pipe.incr(`feed:${userId}:version`);
    pipe.incr(`feed:trending:version`);
    await pipe.exec();

    return res.json({ success: true });
  } catch (err: any) {
    if (err.message.includes("Too many")) {
      return res.status(429).json({ error: err.message });
    }

    console.error(err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// =========================
// 4. FETCH COMMENTS (INFINITE SCROLL)
// =========================
router.get("/api/comments/:postId", async (req, res) => {
  const { postId } = req.params;
  const { cursor } = req.query;

  try {
    const decodedCursor = cursor ? decodeCursor(cursor as string) : null;

    const cacheKey = await buildCommentsKey(
      postId,
      cursor ? (cursor as string) : null,
    );

    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    let query;

    if (decodedCursor) {
      query = sql`
        SELECT *
        FROM comments
        WHERE post_id = ${postId}
          AND parent_id IS NULL
          AND (created_at, id) < (${decodedCursor.created_at}, ${decodedCursor.id})
        ORDER BY created_at DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
    } else {
      query = sql`
        SELECT *
        FROM comments
        WHERE post_id = ${postId}
          AND parent_id IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
    }

    const result = await db.execute(query);

    const hasMore = result.rows.length > PAGE_SIZE;
    const comments = result.rows.slice(0, PAGE_SIZE);

    const ids = comments.map((c: any) => c.id);

    let replies: any[] = [];

    if (ids.length > 0) {
      const replyRes = await db.execute(sql`
        SELECT *
        FROM comments
        WHERE parent_id = ANY(${sql.array(ids, "uuid")})
        ORDER BY created_at ASC
      `);
      replies = replyRes.rows;
    }

    const replyMap = new Map();
    for (const r of replies) {
      if (!replyMap.has(r.parent_id)) {
        replyMap.set(r.parent_id, []);
      }
      replyMap.get(r.parent_id).push(r);
    }

    const enriched = comments.map((c: any) => ({
      ...c,
      replies: replyMap.get(c.id) || [],
    }));

    const nextCursor = hasMore
      ? encodeCursor({
          created_at: comments[comments.length - 1].created_at,
          id: comments[comments.length - 1].id,
        })
      : null;

    const response = {
      comments: enriched,
      nextCursor,
      hasMore,
    };

    await redis.set(cacheKey, JSON.stringify(response), "EX", CACHE_TTL);

    return res.json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

export default router;
