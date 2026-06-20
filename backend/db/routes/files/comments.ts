import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { buildCommentsKey } from "@/utils/cache";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────

const PAGE_SIZE          = 10;
const CACHE_TTL          = 60;
const MAX_COMMENT_LENGTH = 2000;
const RATE_LIMIT_WINDOW  = 60;
const RATE_LIMIT_MAX     = 15;

// ── Rate limiter (atomic) ─────────────────────────────────────────────────────

async function rateLimit(userId: string, action: string): Promise<void> {
  const key = `rate:${action}:${userId}`;

  const tx = redis.multi();
  tx.incr(key);
  tx.expire(key, RATE_LIMIT_WINDOW);
  const [count] = await tx.exec();

  if ((count as number) > RATE_LIMIT_MAX) {
    throw new Error("Too many requests");
  }
}

// ── Cursor helpers ────────────────────────────────────────────────────────────
//
// BUG FIX 1: was Buffer.from(...).toString("base64") — standard base64
//   produces +, /, = characters that are not URL-safe. When the cursor
//   is passed as a query parameter it gets mangled without explicit
//   percent-encoding. Changed to base64url throughout, consistent with
//   all other routes in the codebase.
//
// BUG FIX 2: encodeCursor/decodeCursor were typed as `any`.
//   Added explicit CommentCursor type.

interface CommentCursor {
  created_at: string;
  id: string;
}

function encodeCursor(data: CommentCursor): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

function decodeCursor(cursor: string): CommentCursor {
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as CommentCursor;
  } catch {
    throw new Error("Invalid cursor");
  }
}

// ── 1. CREATE COMMENT ─────────────────────────────────────────────────────────

router.post("/api/comments", async (req, res) => {
  const { userId, postId, content, parentId } = req.body;

  if (!userId || !postId || !content) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (content.length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ error: "Comment too long" });
  }

  let createdComment: Record<string, unknown> | undefined;
  let slug: string | undefined;
  let categoryId: string | null = null;

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

      slug       = post.rows[0].slug as string;
      categoryId = post.rows[0].category_id as string | null;

      const insert = await tx.execute(sql`
        INSERT INTO comments (content, user_id, post_id, parent_id)
        VALUES (${content}, ${userId}, ${postId}, ${parentId ?? null})
        RETURNING *
      `);

      createdComment = insert.rows[0] as Record<string, unknown>;

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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }
    if (message === "Invalid post") {
      return res.status(400).json({ error: "Post not found" });
    }

    console.error("[comments] CREATE error:", err);
    return res.status(500).json({ error: "Create failed" });
  }
});

// ── 2. UPDATE COMMENT ─────────────────────────────────────────────────────────

router.put("/api/comments/:id", async (req, res) => {
  const { id }              = req.params;
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

    const postId = result.rows[0].post_id as string;

    const pipe = redis.multi();
    pipe.incr(`comments:${postId}:version`);
    pipe.incr(`feed:${userId}:version`);
    await pipe.exec();

    return res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }

    console.error("[comments] UPDATE error:", err);
    return res.status(500).json({ error: "Update failed" });
  }
});

// ── 3. DELETE COMMENT ─────────────────────────────────────────────────────────

router.delete("/api/comments/:id", async (req, res) => {
  const { id }     = req.params;
  const { userId } = req.body;

  if (!id || !userId) {
    return res.status(400).json({ error: "Missing fields" });
  }

  let postId:     string | null = null;
  let slug:       string | null = null;
  let categoryId: string | null = null;

  try {
    await rateLimit(userId, "delete_comment");

    await db.transaction(async (tx) => {
      // 1. Find the comment and verify ownership
      const comment = await tx.execute(sql`
        SELECT post_id
        FROM comments
        WHERE id = ${id}
          AND user_id = ${userId}
      `);

      if (comment.rows.length === 0) return; // not found or not owner

      postId = comment.rows[0].post_id as string;

      // BUG FIX: was accessing post.rows[0] without checking length.
      // If the post was deleted between the comment lookup and this query
      // (data inconsistency), post.rows would be empty and accessing [0]
      // would give undefined, making slug = undefined and categoryId crash.
      const post = await tx.execute(sql`
        SELECT slug, category_id
        FROM posts
        WHERE id = ${postId}
      `);

      if (post.rows.length === 0) {
        // Post deleted — still clean up the orphaned comment
        await tx.execute(sql`DELETE FROM comments WHERE id = ${id}`);
        return;
      }

      slug       = post.rows[0].slug       as string;
      categoryId = post.rows[0].category_id as string | null;

      // 2. Delete the comment
      await tx.execute(sql`DELETE FROM comments WHERE id = ${id}`);

      // 3. Decrement post counters (clamped at 0)
      await tx.execute(sql`
        UPDATE posts
        SET score          = GREATEST(score - 7, 0),
            comments_count = GREATEST(comments_count - 1, 0)
        WHERE id = ${postId}
      `);

      // 4. Decrement user behavior (clamped at 1)
      if (categoryId) {
        await tx.execute(sql`
          UPDATE user_behavior
          SET score = GREATEST(score - 7, 1)
          WHERE user_id    = ${userId}
            AND category_id = ${categoryId}
        `);
      }
    });

    // Comment was not found — return early cleanly
    if (!postId) {
      return res.json({ success: true, deleted: false });
    }

    const pipe = redis.multi();
    pipe.incr(`comments:${postId}:version`);
    // Only invalidate post/feed caches if we have a valid slug
    if (slug) pipe.incr(`post:${slug}:version`);
    pipe.incr(`feed:${userId}:version`);
    pipe.incr(`feed:trending:version`);
    await pipe.exec();

    return res.json({ success: true, deleted: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";

    if (message.includes("Too many")) {
      return res.status(429).json({ error: message });
    }

    console.error("[comments] DELETE error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// ── 4. FETCH COMMENTS (infinite scroll) ──────────────────────────────────────

router.get("/api/comments/:postId", async (req, res) => {
  const { postId }  = req.params;
  const { cursor }  = req.query;

  try {
    const decodedCursor = cursor ? decodeCursor(cursor as string) : null;

    const cacheKey = await buildCommentsKey(
      postId,
      cursor ? (cursor as string) : null,
    );

    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const query = decodedCursor
      ? sql`
          SELECT *
          FROM comments
          WHERE post_id   = ${postId}
            AND parent_id IS NULL
            AND (created_at, id) < (
              ${decodedCursor.created_at}::timestamp,
              ${decodedCursor.id}::uuid
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ${PAGE_SIZE + 1}
        `
      : sql`
          SELECT *
          FROM comments
          WHERE post_id   = ${postId}
            AND parent_id IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${PAGE_SIZE + 1}
        `;

    const result  = await db.execute(query);
    const hasMore = result.rows.length > PAGE_SIZE;
    const rows    = result.rows.slice(0, PAGE_SIZE) as Array<{
      id: string;
      created_at: Date;
      [key: string]: unknown;
    }>;

    // Fetch replies for this page of top-level comments in one query
    const ids = rows.map((c) => c.id);

    const replies: Array<{ parent_id: string; [key: string]: unknown }> = [];

    if (ids.length > 0) {
      const replyRes = await db.execute(sql`
        SELECT *
        FROM comments
        WHERE parent_id = ANY(${sql.array(ids, "uuid")})
        ORDER BY created_at ASC
      `);
      replies.push(
        ...(replyRes.rows as Array<{
          parent_id: string;
          [key: string]: unknown;
        }>),
      );
    }

    // Group replies by parent_id
    const replyMap = new Map<string, typeof replies>();
    for (const r of replies) {
      if (!replyMap.has(r.parent_id)) replyMap.set(r.parent_id, []);
      replyMap.get(r.parent_id)!.push(r);
    }

    const enriched = rows.map((c) => ({
      ...c,
      replies: replyMap.get(c.id) ?? [],
    }));

    const nextCursor = hasMore
      ? encodeCursor({
          created_at: new Date(rows[rows.length - 1].created_at).toISOString(),
          id:         rows[rows.length - 1].id,
        })
      : null;

    const response = { comments: enriched, nextCursor, hasMore };

    // BUG FIX: was redis.set(key, val, "EX", TTL) — ioredis positional syntax.
    // node-redis v4 requires object options: { EX: TTL }
    await redis.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });

    return res.json(response);
  } catch (err) {
    console.error("[comments] FETCH error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

export default router;
