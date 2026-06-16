// Like a post
import { db } from "@/db";
import { likes } from "@/db/schema";

await db.insert(likes).values({ userId, postId });
// DB materialized counter
await db.execute(sql`
  UPDATE posts SET likes_count = likes_count + 1 WHERE id = ${postId}
`);
// Redis real-time
await redis.incr(`post:${postId}:likes`);


// Unlike a post
await db.delete(likes).where(...);

await db.execute(sql`
  UPDATE posts SET likes_count = likes_count - 1 WHERE id = ${postId}
`);
await redis.decr(`post:${postId}:likes`);

// count likes for a post
import { sql } from "drizzle-orm";

const result = await db
  .select({
    count: sql<number>`count(*)`,
  })
  .from(likes)
  .where(eq(likes.postId, postId));

// check if user liked a post
const liked = await db
  .select()
  .from(likes)
  .where(and(eq(likes.userId, userId), eq(likes.postId, postId)))
  .limit(1);

// VIRAL DETECTION ENGINE
// This is VERY important for Eaglespress growth.
// update when user interacts
post.score += 5; // like
post.score += 2; // click
post.score += 10; // share

// ── Signal Weights ────────────────────────────────────────────────────────────

export const SIGNAL_WEIGHTS = {
  share:       10,
  bookmark:    8,
  comment:     7,
  fullRead:    6,
  like:        5,
  read: 2,
 
} as const

// VERY IMPORTANT BELOW
// 🧠 1. USER BEHAVIOR TRACKING (CORE SYSTEM) This is your ranking brain — same idea used by TikTok
// DATABASE (Drizzle + Postgres)
export const userBehavior = pgTable("user_behavior", {
  userId: uuid("user_id").notNull(),
  category: text("category").notNull(),
  score: integer("score").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.category] }),
}));

// ⚡ 2. UPDATE BEHAVIOR (LIKE, VIEW, LONG READ) - 👍 LIKE EVENT (+5)
app.post("/api/like", async (req, res) => {
  const { postId, category } = req.body;

  await db.execute(sql`
    INSERT INTO user_behavior (user_id, category, score)
    VALUES (${userId}, ${category}, 5)
    ON CONFLICT (user_id, category)
    DO UPDATE SET 
      score = user_behavior.score + 5,
      updated_at = NOW();
  `);

  res.json({ success: true });
});

// 👀 VIEW EVENT (+1) - Trigger when post enters viewport:
app.post("/api/view", async (req, res) => {
  const { category } = req.body;

  await db.execute(sql`
    INSERT INTO user_behavior (user_id, category, score)
    VALUES (${userId}, ${category}, 1)
    ON CONFLICT (user_id, category)
    DO UPDATE SET 
      score = user_behavior.score + 1,
      updated_at = NOW();
  `);

  res.json({ success: true });
});

// ⏱️ LONG READ EVENT (+3) - Trigger after ~5–10 seconds:
app.post("/api/long-read", async (req, res) => {
  const { category } = req.body;

  await db.execute(sql`
    INSERT INTO user_behavior (user_id, category, score)
    VALUES (${userId}, ${category}, 3)
    ON CONFLICT (user_id, category)
    DO UPDATE SET 
      score = user_behavior.score + 3,
      updated_at = NOW();
  `);

  res.json({ success: true });
});

// FRONTEND TRACKING (Next.js)
// 👀 View Tracking (Intersection Observer)
useEffect(() => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        fetch("/api/view", {
          method: "POST",
          body: JSON.stringify({
            category: post.category,
          }),
        });
      }
    });
  });

  observer.observe(ref.current);
}, []);

// ⏱️ Long Read Tracking
useEffect(() => {
  const timer = setTimeout(() => {
    fetch("/api/long-read", {
      method: "POST",
      body: JSON.stringify({
        category: post.category,
      }),
    });
  }, 8000);

  return () => clearTimeout(timer);
}, []);

// 👍 Like Button
const handleLike = async () => {
  await fetch("/api/like", {
    method: "POST",
    body: JSON.stringify({
      postId: post.id,
      category: post.category,
    }),
  });
};










// CACHE KEY BUILDER - Keeps everything consistent and debuggable.
function buildFeedKey(userId: string, cursor?: string) {
  return `feed:${userId}:${cursor ?? "first"}`;
}


// More on caching
// buildFeedKey go into /lib/cache/keys.ts
// implementation
// /lib/cache/keys.ts

export function buildFeedKey(userId: string, cursor?: string) {
  return `feed:${userId}:${cursor ?? "first"}`;
}

export function buildUserFeedSetKey(userId: string) {
  return `feed_keys:${userId}`;
}

// 🧠 WHY THIS IS IMPORTANT
// Later you’ll have: feed, ads, videos, recommendations- 👉 Centralizing prevents key chaos
// 📍 HOW YOU USE IT
import { buildFeedKey } from "@/lib/cache/keys";

const cacheKey = buildFeedKey(userId, cursor);

// 🚀 2. BEST CACHE INVALIDATION STRATEGY
// | Strategy               | Status                     |
// | ---------------------- | -------------------------- |
// | `DEL single key`       | Too limited                |
// | `KEYS pattern`         | ❌ dangerous (blocks Redis) |
// | `SCAN`                 | ✅ safe but slower          |
// | **SET-based tracking** | ✅✅ BEST                    |

// 🏆 WINNER: SET-BASED INVALIDATION 👉 This is what TikTok / Instagram-style feeds use
// ⚡ FULL IMPLEMENTATION (STEP-BY-STEP) 📍 STEP 1 — CACHE KEYS + TRACKING
// File: /services/feed.ts
// NEW getFeed (updated)
import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { buildFeedKey, buildUserFeedSetKey } from "@/lib/cache/keys";

const FEED_TTL = 60;

export async function getFeed(userId: string, cursor?: string) {
  const cacheKey = buildFeedKey(userId, cursor);
  const setKey = buildUserFeedSetKey(userId);

  // 1️⃣ CHECK CACHE
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  // 2️⃣ DB QUERY
  const data = await db.execute(/* your SQL */);

  const result = {
    items: data.rows,
    nextCursor: data.rows.at(-1)?.id ?? null,
  };

  // 3️⃣ STORE CACHE
  await redis.set(cacheKey, JSON.stringify(result), {
    EX: FEED_TTL,
  });

  // 4️⃣ TRACK KEY (🔥 IMPORTANT)
  await redis.sAdd(setKey, cacheKey);

  // keep set TTL in sync
  await redis.expire(setKey, FEED_TTL);

  return result;
}

// 📍 STEP 2 — INVALIDATION FUNCTION (CORE)
// File: /lib/cache/invalidate.ts
import { redis } from "@/lib/redis";
import { buildUserFeedSetKey } from "@/lib/cache/keys";

export async function invalidateUserFeed(userId: string) {
  const setKey = buildUserFeedSetKey(userId);

  // 1️⃣ GET ALL CACHE KEYS FOR USER
  const keys = await redis.sMembers(setKey);

  if (keys.length > 0) {
    // 2️⃣ DELETE ALL FEED PAGES
    await redis.del(keys);
  }

  // 3️⃣ DELETE TRACKING SET
  await redis.del(setKey);

  console.log("🧹 Feed cache cleared for:", userId);
}

// 📍 STEP 3 — PARTIAL INVALIDATION (SMART UX)
// ✅ ONLY REFRESH FIRST PAGE
import { redis } from "@/lib/redis";
import { buildFeedKey } from "@/lib/cache/keys";

export async function invalidateFirstPage(userId: string) {
  const firstKey = buildFeedKey(userId);

  await redis.del(firstKey);
}

// 🧠 WHEN TO USE EACH (CRITICAL) 🎯 USER ACTIONS
// ❤️ Like a post
await invalidateFirstPage(userId);

// 👉 Why: Only top of feed changes
// 🔔 Follow new category
await invalidateUserFeed(userId);

// 👉 Why: Entire feed changes
// 📰 New post created
// 👉 Advanced case (fan-out):
await invalidateFirstPage(userId);

// ⚡ 4. WHERE THIS IS CALLED IN YOUR APP
// 📍 Example: Like Post API /app/api/posts/[id]/like/route.ts
// ✅ IMPLEMENTATION
import { invalidateFirstPage } from "@/lib/cache/invalidate";

export async function POST(req: Request) {
  const userId = "current-user-id";

  // 1️⃣ update DB
  await db.execute(/* like logic */);

  // 2️⃣ invalidate cache
  await invalidateFirstPage(userId);

  return Response.json({ success: true });
}

// 📍 Example: Follow Category /app/api/categories/follow/route.ts
import { invalidateUserFeed } from "@/lib/cache/invalidate";

await invalidateUserFeed(userId);

// NOT NUMBER 1 IN CHATGPT CONTAINS THE PRECOMPUTE FEED WITH REDIS ALGORITHM



