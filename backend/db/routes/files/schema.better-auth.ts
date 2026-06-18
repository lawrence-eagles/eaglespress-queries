// ── Imports ───────────────────────────────────────────────────────────────────
//
// BUG FIX: `uniqueIndex` was missing from the import list but used in the
// categories table. This caused a compile error — the file would not build.

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
  index,
  uniqueIndex, // BUG FIX: was missing from imports
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── User Table ────────────────────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(), // from Better Auth

  email:    text("email").notNull(),
  name:     text("name"),
  image:    text("image"),

  username:  text("username"),
  avatarUrl: text("avatar_url"),

  interests: jsonb("interests").$type<string[]>(),

  createdAt: timestamp("created_at").defaultNow(),
});

// ── Posts Table ───────────────────────────────────────────────────────────────
//
// BUG FIX: `clicks` column was missing from this table but referenced in:
//   - single-post.ts: SELECT p.clicks
//   - single-post.ts: UPDATE posts SET clicks = clicks + 1
//   - single-post.ts: if ((p.clicks ?? 0) > 10)
// All three references would throw a runtime DB error without this column.

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    title:       text("title").notNull(),
    slug:        text("slug").notNull(),
    description: text("description"),
    url:         text("url").notNull(),
    imageUrl:    text("image_url"),

    sourceId:   uuid("source_id").references(() => sources.id),
    categoryId: uuid("category_id").references(() => categories.id),

    score:  integer("score").default(0),
    clicks: integer("clicks").default(0), // BUG FIX: was missing, used in single-post.ts

    // Materialized counters — updated by triggers or application logic
    likesCount:    integer("likes_count").default(0),
    commentsCount: integer("comments_count").default(0),

    publishedAt: timestamp("published_at"),
    createdAt:   timestamp("created_at").defaultNow(),
  },
  (t) => ({
    // Composite index for personalized feed ranking query
    idxPostsTrending: index("idx_posts_trending").on(
      t.score,
      t.createdAt,
      t.id,
    ),

    // Cursor pagination index for latest feed
    idxPostsCreatedAtId: index("idx_posts_created_at_id").on(t.createdAt, t.id),

    idxPostsCategoryId: index("idx_posts_category_id").on(t.categoryId),
    idxPostsSourceId:   index("idx_posts_source_id").on(t.sourceId),
    idxPostsScore:      index("idx_posts_score").on(t.score),

    // Slug lookup for single-post route
    idxPostsSlug: uniqueIndex("idx_posts_slug").on(t.slug),
  }),
);

// ── Sources Table ─────────────────────────────────────────────────────────────

export const sources = pgTable("sources", {
  id:  uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url:  text("url").notNull().unique(),
});

// ── Categories Table ──────────────────────────────────────────────────────────

export const categories = pgTable(
  "categories",
  {
    id:   uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("categories_name_idx").on(t.name),
    slugIdx: uniqueIndex("categories_slug_idx").on(t.slug),
  }),
);

// ── Likes Table ───────────────────────────────────────────────────────────────

export const likes = pgTable(
  "likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),

    idxLikesPostId:   index("idx_likes_post_id").on(t.postId),
    idxLikesUserPost: index("idx_likes_user_post").on(t.userId, t.postId),
  }),
);

// ── Bookmarks Table ───────────────────────────────────────────────────────────

export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),

    idxBookmarksUserPost: index("idx_bookmarks_user_post").on(
      t.userId,
      t.postId,
    ),
  }),
);

// ── Comments Table ────────────────────────────────────────────────────────────

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    content: text("content").notNull(),

    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    postId: uuid("post_id").references(() => posts.id, {
      onDelete: "cascade",
    }),

    parentId: uuid("parent_id"),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    idxCommentsPostId:      index("idx_comments_post_id").on(t.postId),
    idxCommentsParentId:    index("idx_comments_parent_id").on(t.parentId),
    idxCommentsPostCreated: index("idx_comments_post_created").on(
      t.postId,
      t.createdAt,
    ),
  }),
);

// ── Follows Table ─────────────────────────────────────────────────────────────

export const follows = pgTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),

    idxFollowsCategoryUser: index("idx_follows_category_user").on(
      t.categoryId,
      t.userId,
    ),
  }),
);

// ── User Behavior Table ───────────────────────────────────────────────────────

export const userBehavior = pgTable(
  "user_behavior",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),

    score: integer("score").default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),

    idxCategoryUser: index("idx_user_behavior_category_user").on(
      t.categoryId,
      t.userId,
    ),

    idxCategory: index("idx_user_behavior_category").on(t.categoryId),
  }),
);

// ── Relations ─────────────────────────────────────────────────────────────────

export const userRelations = relations(user, ({ many }) => ({
  likes:     many(likes),
  bookmarks: many(bookmarks),
  comments:  many(comments),
  follows:   many(follows),
  behavior:  many(userBehavior),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  source: one(sources, {
    fields:     [posts.sourceId],
    references: [sources.id],
  }),

  category: one(categories, {
    fields:     [posts.categoryId],
    references: [categories.id],
  }),

  likes:     many(likes),
  bookmarks: many(bookmarks),
  comments:  many(comments),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  posts:     many(posts),
  followers: many(follows),
  behavior:  many(userBehavior),
}));

export const sourcesRelations = relations(sources, ({ many }) => ({
  posts: many(posts),
}));

export const likesRelations = relations(likes, ({ one }) => ({
  user: one(user, {
    fields:     [likes.userId],
    references: [user.id],
  }),
  post: one(posts, {
    fields:     [likes.postId],
    references: [posts.id],
  }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(user, {
    fields:     [bookmarks.userId],
    references: [user.id],
  }),
  post: one(posts, {
    fields:     [bookmarks.postId],
    references: [posts.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  user: one(user, {
    fields:     [comments.userId],
    references: [user.id],
  }),
  post: one(posts, {
    fields:     [comments.postId],
    references: [posts.id],
  }),
  parent: one(comments, {
    fields:     [comments.parentId],
    references: [comments.id],
  }),
  replies: many(comments),
}));

export const followsRelations = relations(follows, ({ one }) => ({
  user: one(user, {
    fields:     [follows.userId],
    references: [user.id],
  }),
  category: one(categories, {
    fields:     [follows.categoryId],
    references: [categories.id],
  }),
}));

export const userBehaviorRelations = relations(userBehavior, ({ one }) => ({
  user: one(user, {
    fields:     [userBehavior.userId],
    references: [user.id],
  }),
  category: one(categories, {
    fields:     [userBehavior.categoryId],
    references: [categories.id],
  }),
}));
