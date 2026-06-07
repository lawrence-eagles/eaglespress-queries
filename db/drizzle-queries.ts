// Like a post
import { db } from "@/db";
import { likes } from "@/db/schema";

await db.insert(likes).values({
  userId,
  postId,
});

// Unlike a post
import { and, eq } from "drizzle-orm";

await db
  .delete(likes)
  .where(and(eq(likes.userId, userId), eq(likes.postId, postId)));

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

// Feed ranking algorithm - Tiktok style
// Basic ranking formula: score = (likes + comments + shares) / (age_in_hours ^ 1.5) - copilot formula
//  score = (likes * 3) + (recency factor) + (user interest match) - chat GPT formula
// best formular for engagement (score * 3 + likes * 2 + comments * 1) - chat GPT formula

// Drizzle query - for headlines, category, trending, videos etc
// I NEED TO UPDATE THIS QUERY TO WORK WITH INFINITE SCROLLING AND TO USE .QUERY() INSTEAD OF .SELECT() TO CALCULATE THE SCORE ON THE FLY - for category add filter .where(eq(posts.category, "sports"))
// COALESE Handle NULL scores
import { desc, sql } from "drizzle-orm";

const feed = await db
  .select({
    id: posts.id,
    title: posts.title,
    score: sql<number>`
      (COALESCE(${posts.score}, 0) * 3) +
      (EXTRACT(EPOCH FROM NOW() - ${posts.createdAt}) * -0.0001)
    `,
  })
  .from(posts)
  .orderBy(desc(sql`score`))
  .limit(20);

  // Feed personalization for user Feed - the user home page
  // I NEED TO UPDATE THIS QUERY TO WORK WITH INFINITE SCROLLING AND TO USE .QUERY() INSTEAD OF .SELECT() AND RAW SQL
  // Works with infinite scrolling by using cursor-based pagination (created_at < cursor)
const feed = await db.execute(sql`
  SELECT p.*
  FROM posts p
  JOIN user_behavior ub
    ON ub.category = p.category
  WHERE 
    ub.user_id = ${userId}
    ${cursor ? sql`AND p.created_at < ${cursor}` : sql``}
  ORDER BY
    (
      ub.score * 5 +
      p.score * 2 -
      EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
    ) DESC,
    p.created_at DESC
  LIMIT 20;
`);
// IMPORTANT IMPROVEMENTS (DO THIS)
// IMPORTANT IMPROVEMENTS (DO THIS) -- Done
// Fallback for New Users - If no user_behavior: 👉 Show trending posts instead
// Add Diversity (VERY IMPORTANT) - Avoid showing only one category: 👉 Mix categories slightly
// Limit per category - Prevent spam: ROW_NUMBER() OVER (PARTITION BY p.category)

// Backend implementation of the feed ranking algorithm above in a route handler:
app.get("/api/feed", async (req, res) => {
  const { cursor } = req.query;

  const feed = await db.execute(sql`
    SELECT p.*
    FROM posts p
    JOIN user_behavior ub
      ON ub.category = p.category
    WHERE 
      ub.user_id = ${userId}
      ${cursor ? sql`AND p.created_at < ${cursor}` : sql``}
    ORDER BY
      (
        ub.score * 5 +
        p.score * 2 -
        EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
      ) DESC,
      p.created_at DESC
    LIMIT 20;
  `);

  const nextCursor = feed.rows.at(-1)?.created_at;

  res.json({
    posts: feed.rows,
    nextCursor,
  });
});

// Frontend code
// import { useInfiniteQuery } from "@tanstack/react-query";

// export const useFeed = () => {
//   return useInfiniteQuery({
//     queryKey: ["feed"],
//     queryFn: async ({ pageParam }) => {
//       const res = await fetch(`/api/feed?cursor=${pageParam ?? ""}`);
//       return res.json();
//     },
//     getNextPageParam: (lastPage) => lastPage.nextCursor,
//   });
// };
// Usage const { data, fetchNextPage, hasNextPage } = useFeed();

// IMPORTANT IMPROVEMENTS (VERY IMPORTANT)
// 1. Cursor Should Include Score (ADVANCED) Because ranking is dynamic:
// 👉 Best practice: cursor = { score, created_at }
// 2. Use Composite Cursor (PRO LEVEL)
// WHERE 
// (
//   score < lastScore
//   OR (score = lastScore AND created_at < lastCreatedAt)
// )
// 3. Prevent Feed Jumping Ranking changes over time → results shift 👉 Fix later with:
// Cached feeds (Redis) - Precomputed feeds

// FINAL PRODUCTION VERSION (ADVANCED) - works with infinite scrolling and uses composite cursor (score + created_at) for stable pagination
const feed = await db.execute(sql`
  SELECT p.*
  FROM posts p
  JOIN user_behavior ub
    ON ub.category = p.category
  WHERE 
    ub.user_id = ${userId}
    ${
      cursor
        ? sql`
        AND (
          (
            ub.score * 5 +
            p.score * 2 -
            EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
          ) < ${cursor.score}
          OR (
            (
              ub.score * 5 +
              p.score * 2 -
              EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
            ) = ${cursor.score}
            AND p.created_at < ${cursor.createdAt}
          )
        )
        `
        : sql``
    }
  ORDER BY
    (
      ub.score * 5 +
      p.score * 2 -
      EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
    ) DESC,
    p.created_at DESC
  LIMIT 20;
`);

// Advance Improvements
// 1 REDIS CACHING (ADD LATER, BUT DESIGN NOW)
// Cache Strategy
// Key: 
feed:${userId}

// Cached Feed Shape
type CachedFeed = {
  posts: Post[];
  nextCursor: string;
};

// Optional Redis wrapper for caching feeds
// lib/cache.ts
export const getCachedFeed = async (userId: string) => {
  // later: redis.get(`feed:${userId}`)
  return null;
};

export const setCachedFeed = async (
  userId: string,
  data: any
) => {
  // later: redis.set(...)
};

// 2. PRECOMPUTED FEEDS (INNGEST 🔥)
// 👉 Instead of computing feed on every request
// 👉 Precompute it in background
// Inngest job to precompute feeds
// inngest/functions/generateFeed.ts
import { inngest } from "../client";

export const generateFeed = inngest.createFunction(
  { id: "generate-user-feed" },
  { event: "feed.generate" },
  async ({ event, step }) => {
    const { userId } = event.data;

    const posts = await step.run("fetch-feed", async () => {
      return db.execute(sql`
        SELECT p.*
        FROM posts p
        JOIN user_behavior ub
          ON ub.category = p.category
        WHERE ub.user_id = ${userId}
        ORDER BY
          (ub.score * 5 + p.score * 2) DESC
        LIMIT 100;
      `);
    });

    // later → cache in Redis
    return posts;
  }
);

// When to trigger this
// User logs in
// User likes a post
// User follows category

// 3 USER BEHAVIOR TRACKING (FEED BRAIN) 👉 This powers your ranking algorithm
// user behavior table - tracks user interactions with categories
export const userBehavior = pgTable("user_behavior", {
  userId: uuid("user_id").notNull(),
  category: text("category").notNull(),
  score: integer("score").default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.category] }),
}));

// Update Behavior 
// 👍 Like = +5
await db.execute(sql`
  INSERT INTO user_behavior (user_id, category, score)
  VALUES (${userId}, ${category}, 5)
  ON CONFLICT (user_id, category)
  DO UPDATE SET score = user_behavior.score + 5;
`);

// 👀 View = +1
score + 1

// ⏱️ Long read = +3
score + 3

// FINAL FEED API (PRODUCTION READY) - SEEN POSTS FILTERING (CRITICAL)
app.get("/api/feed", async (req, res) => {
  const { cursor, scoreCursor } = req.query;

  const feed = await db.execute(sql`
    SELECT p.*
    FROM posts p
    JOIN user_behavior ub
      ON ub.category = p.category
    WHERE 
      ub.user_id = ${userId}
      AND p.id NOT IN (
        SELECT post_id FROM seen_posts WHERE user_id = ${userId}
      )
      ${
        cursor
          ? sql`
        AND (
          (
            ub.score * 5 +
            p.score * 2 -
            EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
          ) < ${scoreCursor}
          OR (
            (
              ub.score * 5 +
              p.score * 2 -
              EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
            ) = ${scoreCursor}
            AND p.created_at < ${cursor}
          )
        )
        `
          : sql``
      }
    ORDER BY
      (
        ub.score * 5 +
        p.score * 2 -
        EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
      ) DESC,
      p.created_at DESC
    LIMIT 20;
  `);

  const last = feed.rows.at(-1);

  res.json({
    posts: feed.rows,
    nextCursor: last?.created_at,
    nextScore: last
      ? last.score
      : null,
  });
});

// FRONTEND (REACT QUERY + ZUSTAND)
// Zustand Store
import { create } from "zustand";

export const useFeedStore = create((set) => ({
  seen: new Set<string>(),
  addSeen: (ids: string[]) =>
    set((state) => {
      ids.forEach((id) => state.seen.add(id));
      return { seen: state.seen };
    }),
}));

// Infinite Query
export const useFeed = () => {
  return useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: async ({ pageParam }) => {
      const res = await fetch(
        `/api/feed?cursor=${pageParam?.cursor || ""}&scoreCursor=${pageParam?.score || ""}`
      );
      return res.json();
    },
    getNextPageParam: (lastPage) => ({
      cursor: lastPage.nextCursor,
      score: lastPage.nextScore,
    }),
  });
};

// 👀 Track Seen Posts
useEffect(() => {
  if (!data) return;

  const ids = data.pages.flatMap((p) =>
    p.posts.map((post) => post.id)
  );

  fetch("/api/seen", {
    method: "POST",
    body: JSON.stringify({ postIds: ids }),
  });
}, [data]);

// CODE TO REMOVE THE SEEN CODE FILTERING BELOW ARE THE UPDATES
// User behavior table - tracks user interactions with categories
export const userBehavior = pgTable("user_behavior", {
  userId: uuid("user_id").notNull(),
  category: text("category").notNull(),
  score: integer("score").default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.category] }),
}));

// 🔥 UPDATED FEED QUERY (SIMPLIFIED + FASTER)
const feed = await db.execute(sql`
  SELECT p.*
  FROM posts p
  JOIN user_behavior ub
    ON ub.category = p.category
  WHERE 
    ub.user_id = ${userId}
    ${
      cursor
        ? sql`
        AND (
          (
            ub.score * 5 +
            p.score * 2 -
            EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
          ) < ${scoreCursor}
          OR (
            (
              ub.score * 5 +
              p.score * 2 -
              EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
            ) = ${scoreCursor}
            AND p.created_at < ${cursor}
          )
        )
        `
        : sql``
    }
  ORDER BY
    (
      ub.score * 5 +
      p.score * 2 -
      EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
    ) DESC,
    p.created_at DESC
  LIMIT 20;
`);

// NOTE
// ⚠️ NEW PROBLEM (IMPORTANT) Without seen filtering: 👉 Users might see too many repeats
// 🔥 SOLUTION: SOFT DEDUPING (SMART WAY)Instead of blocking posts, we reduce their ranking
// 🧠 Add "last_seen_at" to behavior (OPTIONAL)
// future upgrade idea
// lastSeenAt: timestamp("last_seen_at")
//🧠 Or decay score by time (BEST SIMPLE FIX)
// You already have this:
// EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
// 👉 This ensures: Older posts slowly drop, New posts rise

// UPDATED API IN EXPRESS ROUTE
app.get("/api/feed", async (req, res) => {
  const { cursor, scoreCursor } = req.query;

  const feed = await db.execute(sql`
    SELECT p.*
    FROM posts p
    JOIN user_behavior ub
      ON ub.category = p.category
    WHERE 
      ub.user_id = ${userId}
      ${
        cursor
          ? sql`
        AND (
          (
            ub.score * 5 +
            p.score * 2 -
            EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
          ) < ${scoreCursor}
          OR (
            (
              ub.score * 5 +
              p.score * 2 -
              EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
            ) = ${scoreCursor}
            AND p.created_at < ${cursor}
          )
        )
        `
          : sql``
      }
    ORDER BY
      (
        ub.score * 5 +
        p.score * 2 -
        EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001
      ) DESC,
      p.created_at DESC
    LIMIT 20;
  `);

  const last = feed.rows.at(-1);

  res.json({
    posts: feed.rows,
    nextCursor: last?.created_at,
    nextScore: last?.score ?? null,
  });
});

// FRONTEND (SIMPLIFIED) ❌ REMOVE THIS
// /api/seen ❌ DELETE
// zustand seen store ❌ DELETE

// ✅ KEEP INFINITE SCROLL
export const useFeed = () => {
  return useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: async ({ pageParam }) => {
      const res = await fetch(
        `/api/feed?cursor=${pageParam?.cursor || ""}&scoreCursor=${pageParam?.score || ""}`
      );
      return res.json();
    },
    getNextPageParam: (lastPage) => ({
      cursor: lastPage.nextCursor,
      score: lastPage.nextScore,
    }),
  });
};

// NEW FEATURES
// 🚀 WHAT WE’RE BUILDING
// ✅ Feed diversity (avoid same category spam)
// ✅ Explore vs Following feeds
// ✅ Real-time updates (WebSockets)
// ✅ Ad injection system (monetization)
// ✅ User behavior tracking (likes, views, long reads) ← FULL IMPLEMENTATION

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

// 🧠 3. FEED DIVERSITY (VERY IMPORTANT) 
// 👉 Prevent 20 posts from same category SQL FIX (LIMIT PER CATEGORY)
const feed = await db.execute(sql`
  SELECT * FROM (
    SELECT 
      p.*,
      ROW_NUMBER() OVER (PARTITION BY p.category ORDER BY p.created_at DESC) as rn
    FROM posts p
    JOIN user_behavior ub
      ON ub.category = p.category
    WHERE ub.user_id = ${userId}
  ) sub
  WHERE rn <= 3
  ORDER BY created_at DESC
  LIMIT 20;
`);

// 🔀 4. EXPLORE vs FOLLOWING FEED
// 🧠 FOLLOWING FEED 👉 Based on user behavior (your current system) I AL READY HAVE THIS IN MY CURRENT SYSTEM SETUP

// 🧠 EXPLORE FEED 👉 Trending posts across all categories (no personalization)
// 🌍 EXPLORE FEED 👉 No personalization — trending content
SELECT *
FROM posts
ORDER BY score DESC, created_at DESC
LIMIT 20;

// API
// GET /api/feed?type=following
// GET /api/feed?type=explore

// MONETIZATION
// 💰 5. AD INJECTION SYSTEM
// 🧠 Strategy 👉 Insert ad every N posts
function injectAds(posts: any[]) {
  const result = [];

  posts.forEach((post, i) => {
    if (i % 5 === 0) {
      result.push({
        id: `ad-${i}`,
        type: "ad",
      });
    }
    result.push(post);
  });

  return result;
}

// Frontend
if (item.type === "ad") {
  return <AdComponent />;
}

// CODE TO RETURN 4 POSTS 1 AD AND 1 YOUTUBE VIDEOS
// STEP 1 — UNIFIED FEED ITEM TYPE (VERY IMPORTANT)
type FeedItem =
  | { type: "post"; data: Post }
  | { type: "video"; data: Video }
  | { type: "ad"; data: Ad };

  // Fetch posts not this is not going to be used the previous smart queries would be used
  const posts = await db.execute(sql`
  SELECT * FROM posts
  ORDER BY created_at DESC
  LIMIT 20;
`);

// Fetch videos this is also not going to be used a tweaked version of the smart queries above would be used
const videos = await db.execute(sql`
  SELECT * FROM videos
  ORDER BY created_at DESC
  LIMIT 10;
`);

// Merge posts and videos
function mergeContent(posts: any[], videos: any[]) {
  const result: any[] = [];

  let i = 0, j = 0;

  while (i < posts.length || j < videos.length) {
    if (i < posts.length) {
      result.push({ type: "post", data: posts[i++] });
    }

    // Insert video every 3 posts
    if (i % 3 === 0 && j < videos.length) {
      result.push({ type: "video", data: videos[j++] });
    }
  }

  return result;
}

// Ad injection after every 4 posts
function injectAds(feed: any[]) {
  const result: any[] = [];
  let postCount = 0;

  for (const item of feed) {
    result.push(item);

    if (item.type === "post") {
      postCount++;
    }

    // After every 4 posts → insert ad
    if (postCount > 0 && postCount % 4 === 0) {
      result.push({
        type: "ad",
        data: {
          id: `ad-${postCount}`,
        },
      });
    }
  }

  return result;
}

// FINAL API ROUTE
app.get("/api/feed", async (req, res) => {
  // 1. Fetch content
  const posts = await getPosts();
  const videos = await getVideos();

  // 2. Merge posts + videos
  const merged = mergeContent(posts, videos);

  // 3. Inject ads every 4 posts
  const finalFeed = injectAds(merged);

  res.json({
    items: finalFeed,
  });
});

// FRONTEND RENDERING
{items.map((item) => {
  if (item.type === "post") {
    return <PostCard post={item.data} />;
  }

  if (item.type === "video") {
    return <VideoCard video={item.data} />;
  }

  if (item.type === "ad") {
    return <AdCard ad={item.data} />;
  }
})}

// Youtube video component
const VideoCard = ({ video }) => {
  return (
    <iframe
      width="100%"
      height="250"
      src={`https://www.youtube.com/embed/${video.youtubeId}`}
      allowFullScreen
    />
  );
};

// Ad component
const AdCard = () => {
  return (
    <div className="ad">
      <p>Sponsored</p>
      <img src="/ad-banner.png" />
    </div>
  );
};

// UPDATED INFINIT SCROLL
useInfiniteQuery({
  queryKey: ["feed"],
  queryFn: async ({ pageParam }) => {
    const res = await fetch(`/api/feed?cursor=${pageParam || ""}`);
    return res.json();
  },
  getNextPageParam: (lastPage) => lastPage.nextCursor,
});


// NOTE ⚠️ IMPORTANT EDGE CASE ❗ Ads repeating too often?
// Fix: 👉 Only inject ads based on global index
// Advanced: const globalIndexOffset = page * 20;
// 🧠 ADVANCED (WHAT BIG APPS DO)
// Platforms like: YouTube TikTok
// 👉 Do: Dynamic ad placement (not fixed 4), Personalized ads, Auction-based ranking







