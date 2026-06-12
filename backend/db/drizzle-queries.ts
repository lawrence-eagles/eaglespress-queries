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
// I NEED TO UPDATE THIS QUERY TO WORK WITH INFINITE SCROLLING TO CALCULATE THE SCORE ON THE FLY - for category add filter .where(eq(posts.category, "sports"))
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

  // THE UPDATED VERSION THAT WORKS WITH INFINITE SCROLLING USING CURSOR BASED PAGINATION
  import { desc, sql, and, lt, or } from "drizzle-orm";

type Cursor = {
  score: number;
  createdAt: Date;
  id: string;
};

export async function getFeed(cursor?: Cursor) {
  const limit = 20;

  const baseScore = sql<number>`
    (COALESCE(${posts.score}, 0) * 3) +
    (EXTRACT(EPOCH FROM NOW() - ${posts.createdAt}) * -0.0001)
  `;

  const whereClause = cursor
    ? or(
        // lower score
        lt(baseScore, cursor.score),

        // same score but older
        and(
          sql`${baseScore} = ${cursor.score}`,
          lt(posts.createdAt, cursor.createdAt)
        ),

        // same score + same time → use id
        and(
          sql`${baseScore} = ${cursor.score}`,
          sql`${posts.createdAt} = ${cursor.createdAt}`,
          lt(posts.id, cursor.id)
        )
      )
    : undefined;

  const data = await db
    .select({
      id: posts.id,
      title: posts.title,
      createdAt: posts.createdAt,
      score: baseScore,
    })
    .from(posts)
    .where(whereClause)
    .orderBy(
      desc(baseScore),
      desc(posts.createdAt),
      desc(posts.id)
    )
    .limit(limit);

  const nextCursor =
    data.length === limit
      ? {
          score: data[data.length - 1].score,
          createdAt: data[data.length - 1].createdAt,
          id: data[data.length - 1].id,
        }
      : null;

  return {
    items: data,
    nextCursor,
  };
}

// API ROUTE FOR THE ABOVE CODE - THE ABOVE CODE CAN BE THE CONTROLLER
app.get("/feed", async (req, res) => {
  const cursor = req.query.cursor
    ? JSON.parse(req.query.cursor as string)
    : undefined;

  const feed = await getFeed(cursor);

  res.json(feed);
});

// . NEXT.JS + REACT QUERY (WEB) - Using TanStack Query
import { useInfiniteQuery } from "@tanstack/react-query";
import axios from "axios";

export function useFeed() {
  return useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: async ({ pageParam }) => {
      const res = await axios.get("/api/feed", {
        params: {
          cursor: pageParam ? JSON.stringify(pageParam) : undefined,
        },
      });

      return res.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

// COMPONENT INFINIT SCROLL
export default function Feed() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFeed();

  return (
    <div>
      {data?.pages.map((page) =>
        page.items.map((post: any) => (
          <div key={post.id}>{post.title}</div>
        ))
      )}

      <button
        onClick={() => fetchNextPage()}
        disabled={!hasNextPage}
      >
        Load More
      </button>
    </div>
  );
}

// REACT NATIVE (EXPO)
const { data, fetchNextPage, hasNextPage } = useFeed();
import { FlatList, Text } from "react-native";

<FlatList
  data={data?.pages.flatMap((p) => p.items) ?? []}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => <Text>{item.title}</Text>}
  onEndReached={() => {
    if (hasNextPage) fetchNextPage();
  }}
  onEndReachedThreshold={0.5}
/>

// ADDING ADS + VIDEOS (IMPORTANT FOR YOU) mixing posts + videos + ads
// Merge feed on backend OR frontend
function injectContent(items) {
  const result = [];

  items.forEach((item, index) => {
    result.push(item);

    if ((index + 1) % 4 === 0) {
      result.push({ type: "ad" });
    }

    if ((index + 1) % 6 === 0) {
      result.push({ type: "video" });
    }
  });

  return result;
}

// NEXT.JS (WEB) — SCROLL TRIGGER
// UPDATED FEED COMPONENT (AUTO LOAD)
"use client";

import { useEffect, useRef } from "react";
import { useFeed } from "@/hooks/useFeed";

export default function Feed() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFeed();

  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];

        if (first.isIntersecting && hasNextPage) {
          fetchNextPage();
        }
      },
      {
        rootMargin: "200px", // preload before user reaches bottom
      }
    );

    observer.observe(loadMoreRef.current);

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage]);

  return (
    <div>
      {data?.pages.map((page) =>
        page.items.map((item: any) => {
          if (item.type === "ad") {
            return <div key={Math.random()}>🔥 Ad</div>;
          }

          if (item.type === "video") {
            return <div key={Math.random()}>🎥 Video</div>;
          }

          return <div key={item.id}>{item.title}</div>;
        })
      )}

      {/* 👇 SCROLL TRIGGER */}
      <div ref={loadMoreRef} style={{ height: 50 }} />

      {isFetchingNextPage && <p>Loading...</p>}
    </div>
  );
}


  // Feed personalization for user Feed - the user home page
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


// FOR YOU QUERY (PERSONALIZED FEED) - compare with what I already have
export async function getForYouFeed(userId: string, cursor?: Cursor) {
  return db.execute(sql`
    SELECT p.*, ub.score as user_score
    FROM posts p
    JOIN user_behavior ub
      ON ub.category_id = p.category_id
    WHERE ub.user_id = ${userId}
    ${
      cursor
        ? sql`
      AND (
        (ub.score * 5 + p.score * 2) < ${cursor.score}
      )
    `
        : sql``
    }
    ORDER BY
      (ub.score * 5 + p.score * 2 -
       EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001) DESC
    LIMIT 20
  `);
}

// FOLLOWING QUERY (following feed) 
export async function getFollowingFeed(userId: string, cursor?: Cursor) {
  return db.execute(sql`
    SELECT p.*
    FROM posts p
    JOIN follows f
      ON f.category_id = p.category_id
    WHERE f.user_id = ${userId}
    ${
      cursor
        ? sql`AND p.created_at < ${cursor.createdAt}`
        : sql``
    }
    ORDER BY p.created_at DESC
    LIMIT 20
  `);
}

// ⚛️ FRONTEND SWITCH (WEB + MOBILE) implementation of the for you and following feed
// Zustand store
import { create } from "zustand";

type FeedType = "forYou" | "following";

export const useFeedType = create<{
  type: FeedType;
  setType: (t: FeedType) => void;
}>((set) => ({
  type: "forYou",
  setType: (type) => set({ type }),
}));

// Toggle UI
const { type, setType } = useFeedType();

<button onClick={() => setType("forYou")}>For You</button>
<button onClick={() => setType("following")}>Following</button>

// React query hook
export function useFeed() {
  const { type } = useFeedType();

  return useInfiniteQuery({
    queryKey: ["feed", type],
    queryFn: async ({ pageParam }) => {
      return axios.get(`/api/feed/${type}`, {
        params: { cursor: pageParam },
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

// 💰 SMART AD TARGETING (VERY IMPORTANT)
// 🧠 AD TARGETING STRATEGY
// Use: user interests (user_behavior), category, device/platform
// ADS Table
export const ads = pgTable("ads", {
  id: uuid("id").primaryKey().defaultRandom(),

  title: text("title"),
  imageUrl: text("image_url"),
  link: text("link"),

  categoryId: uuid("category_id"), // targeting

  budget: integer("budget"),
  impressions: integer("impressions").default(0),

  createdAt: timestamp("created_at").defaultNow(),
});

// Fetch targeted ads
export async function getTargetedAd(userId: string) {
  return db.execute(sql`
    SELECT a.*
    FROM ads a
    JOIN user_behavior ub
      ON ub.category_id = a.category_id
    WHERE ub.user_id = ${userId}
    ORDER BY ub.score DESC
    LIMIT 1
  `);
}

// Inject ads into feeds
function injectAds(items, ads) {
  const result = [];

  items.forEach((item, index) => {
    result.push(item);

    if ((index + 1) % 4 === 0) {
      result.push({
        type: "ad",
        data: ads[index % ads.length],
      });
    }
  });

  return result;
}

// Frontend render
if (item.type === "ad") {
  return (
    <a href={item.data.link}>
      <img src={item.data.imageUrl} />
      <p>{item.data.title}</p>
    </a>
  );
}

// 🧠 1. WHAT “PREFETCH NEXT PAGE” REALLY MEANS
// ❌ Without Prefetch - User scrolls to bottom -> App sends request -> User waits (loading spinner 😴) -> Data arrives
// ✅ With Prefetch -> User is still scrolling -> App already fetches next page in background -> User reaches bottom -> Content is already there (instant ⚡)
// Code goes inside: /app/feed/page.tsx or /components/Feed.tsx
// Get feed hook
const {
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
} = useFeed();

// Add prefetch logic
import { useEffect } from "react";

useEffect(() => {
  if (!data) return;

  const lastPage = data.pages[data.pages.length - 1];

  // 🚀 PREFETCH NEXT PAGE
  if (hasNextPage && !isFetchingNextPage) {
    fetchNextPage();
  }
}, [data]);

// ⚠️ PROBLEM WITH THIS VERSION -> This prefetches too aggressively (loads everything fast)
// So use smart prefetch as seen below:
useEffect(() => {
  const handleScroll = () => {
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const fullHeight = document.body.scrollHeight;

    const scrollPosition = scrollY + viewportHeight;

    // 🎯 Trigger at 70%
    if (scrollPosition > fullHeight * 0.7) {
      if (hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    }
  };

  window.addEventListener("scroll", handleScroll);

  return () => window.removeEventListener("scroll", handleScroll);
}, [hasNextPage, isFetchingNextPage]);

// Mobile implementation
// code goes inside /screens/FeedScreen.tsx
<FlatList
  data={data?.pages.flatMap((p) => p.items) ?? []}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => <Text>{item.title}</Text>}

  // 🚀 PREFETCH TRIGGER
  onEndReached={() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }}

  // 🎯 THIS IS THE MAGIC
  onEndReachedThreshold={0.7}
/>


// complete prefetch logic with debounce
"use client";

import { useEffect, useRef } from "react";
import { useFeed } from "@/hooks/useFeed";

export default function Feed() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFeed();

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const viewport = window.innerHeight;
      const fullHeight = document.body.scrollHeight;

      const position = scrollY + viewport;

      // 🎯 Trigger at 70%
      if (position > fullHeight * 0.7) {
        if (!hasNextPage || isFetchingNextPage) return;

        // 🧠 DEBOUNCE (VERY IMPORTANT)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
          fetchNextPage();
        }, 200); // delay prevents spam calls
      }
    };

    window.addEventListener("scroll", handleScroll);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div>
      {data?.pages.map((page) =>
        page.items.map((item: any, index: number) => {
          if (item.type === "ad") return <div key={index}>🔥 Ad</div>;
          if (item.type === "video") return <div key={index}>🎥 Video</div>;

          return <div key={item.id}>{item.title}</div>;
        })
      )}
    </div>
  );
}

// complete mobile implementation of prefetch logic, Note moible does not need debounce Flatlist is optimized internally
import { FlatList, Text, ActivityIndicator } from "react-native";
import { useFeed } from "../hooks/useFeed";

export default function FeedScreen() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFeed();

  const flatData = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <FlatList
      data={flatData}
      keyExtractor={(item, index) => item.id ?? `special-${index}`}
      renderItem={({ item }) => {
        if (item.type === "ad") return <Text>🔥 Ad</Text>;
        if (item.type === "video") return <Text>🎥 Video</Text>;

        return <Text>{item.title}</Text>;
      }}
      onEndReached={() => {
        if (hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.7}
      ListFooterComponent={
        isFetchingNextPage ? <ActivityIndicator /> : null
      }
    />
  );
}

// REDIS IMPLEMENTATION
// ⚡ 1. REDIS CLIENT SETUP (node-redis)
// 📍 /lib/redis.ts
import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (err) => {
  console.error("Redis Error", err);
});

await redis.connect();

// ⚡ 2. FEED CACHING (REWRITTEN)
// 📍 /services/feed.ts
import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const FEED_TTL = 60; // seconds

export async function getFeed(userId: string, cursor?: string) {
  const cacheKey = buildFeedKey(userId, cursor);

  // 1️⃣ CHECK CACHE
  const cached = await redis.get(cacheKey);

  if (cached) {
    console.log("⚡ CACHE HIT:", cacheKey);
    return JSON.parse(cached);
  }

  console.log("🐢 DB HIT:", cacheKey);

  // 2️⃣ QUERY DB
  const data = await db.execute(sql`
    SELECT p.*
    FROM posts p
    JOIN user_behavior ub
      ON ub.category_id = p.category_id
    WHERE ub.user_id = ${userId}
    ${
      cursor
        ? sql`AND p.id < ${cursor}` // cursor pagination
        : sql``
    }
    ORDER BY
      (ub.score * 5 + p.score * 2 -
       EXTRACT(EPOCH FROM NOW() - p.created_at) * 0.0001) DESC
    LIMIT 20
  `);

  const result = {
    items: data.rows,
    nextCursor: data.rows.at(-1)?.id ?? null,
  };

  // 3️⃣ STORE CACHE
  await redis.set(cacheKey, JSON.stringify(result), {
    EX: FEED_TTL,
  });

  return result;
}

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
  partialRead: 3,
  bounce:     -0.5, // i will not use this criteria.
} as const



