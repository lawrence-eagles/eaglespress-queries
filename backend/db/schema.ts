// Tables

// User table
// db/schema/users.ts
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  password: text("password").notNull(),

  interests: jsonb("interests").$type<string[]>(),

  createdAt: timestamp("created_at").defaultNow(),
});

// Source table
// db/schema/sources.ts
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),

  name: text("name").notNull(),
  // url: text("url"),
  url: text("url").notNull().unique(),
});

// Post table
// db/schema/posts.ts
import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  imageUrl: text("image_url"),

  sourceId: uuid("source_id").references(() => sources.id),

  categoryId: uuid("category_id").references(() => categories.id),

  score: integer("score").default(0),

  createdAt: timestamp("created_at").defaultNow(),
});

// posts table with indexes
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
// import { sources } from "./sources";
// import { categories } from "./categories";

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    imageUrl: text("image_url"),

    sourceId: uuid("source_id").references(() => sources.id),
    categoryId: uuid("category_id").references(() => categories.id),

    score: integer("score").default(0),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    // 🔥 Core feed performance
    idxPostsTrending: index("idx_posts_trending").on(
      table.score,
      table.createdAt,
      table.id,
    ),

    // 🔥 Sorting fallback
    idxPostsCreatedAtId: index("idx_posts_created_at_id").on(
      table.createdAt,
      table.id,
    ),

    // 🔥 Joins
    idxPostsCategoryId: index("idx_posts_category_id").on(table.categoryId),

    idxPostsSourceId: index("idx_posts_source_id").on(table.sourceId),

    // 🔥 Optional (high traffic)
    idxPostsScore: index("idx_posts_score").on(table.score),
  }),
);

// Category table
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").unique().notNull(),
});

// comment table
export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),

  content: text("content").notNull(),

  userId: uuid("user_id").references(() => users.id),
  postId: uuid("post_id").references(() => posts.id),

  parentId: uuid("parent_id"), // replies

  createdAt: timestamp("created_at").defaultNow(),
});

// Like table
export const likes = pgTable(
  "likes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),
  }),
);

// Bookmark table
export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),
  }),
);

// Follows Table
export const follows = pgTable(
  "follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),
  }),
);

// User behaviour table
export const userBehavior = pgTable(
  "user_behavior",
  {
    userId: uuid("user_id").references(() => users.id),
    categoryId: uuid("category_id").references(() => categories.id),

    score: integer("score").default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.categoryId] }),
  }),
);

// Relations
// db/relations/users.ts
import { relations } from "drizzle-orm";
import { users } from "../schema/users";
import { posts } from "../schema/posts";
import { likes } from "../schema/likes";
import { bookmarks } from "../schema/bookmarks";
import { comments } from "../schema/comments";
import { follows } from "../schema/follows";

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),

  likes: many(likes),
  bookmarks: many(bookmarks),
  comments: many(comments),
  follows: many(follows),
}));

// db/relations/posts.ts
// import { relations } from "drizzle-orm";
// import { posts } from "../schema/posts";
// import { users } from "../schema/users";
// import { likes } from "../schema/likes";
// import { bookmarks } from "../schema/bookmarks";
// import { comments } from "../schema/comments";

// export const postsRelations = relations(posts, ({ one, many }) => ({
//   author: one(users, {
//     fields: [posts.source], // if source = userId later
//     references: [users.id],
//   }),

//   likes: many(likes),
//   bookmarks: many(bookmarks),
//   comments: many(comments),
// }));

import { sources } from "../schema/sources";
import { categories } from "../schema/categories";

export const postsRelations = relations(posts, ({ one, many }) => ({
  source: one(sources, {
    fields: [posts.sourceId],
    references: [sources.id],
  }),

  category: one(categories, {
    fields: [posts.categoryId],
    references: [categories.id],
  }),

  likes: many(likes),
  bookmarks: many(bookmarks),
  comments: many(comments),
}));

// source relations
export const sourcesRelations = relations(sources, ({ many }) => ({
  posts: many(posts),
}));

// db/relations/categories.ts
// import { relations } from "drizzle-orm";
// import { categories } from "../schema/categories";
// import { posts } from "../schema/posts";

// export const categoriesRelations = relations(categories, ({ many }) => ({
//   posts: many(posts),
// }));

export const categoriesRelations = relations(categories, ({ many }) => ({
  posts: many(posts),
  followers: many(follows),
}));

// db/relations/likes.ts
import { relations } from "drizzle-orm";
import { likes } from "../schema/likes";
import { users } from "../schema/users";
import { posts } from "../schema/posts";

export const likesRelations = relations(likes, ({ one }) => ({
  user: one(users, {
    fields: [likes.userId],
    references: [users.id],
  }),

  post: one(posts, {
    fields: [likes.postId],
    references: [posts.id],
  }),
}));

// db/relations/bookmarks.ts
// relations
export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),

  post: one(posts, {
    fields: [bookmarks.postId],
    references: [posts.id],
  }),
}));

// db/relations/comments.ts
import { relations } from "drizzle-orm";
import { comments } from "../schema/comments";
import { users } from "../schema/users";
import { posts } from "../schema/posts";

export const commentsRelations = relations(comments, ({ one, many }) => ({
  user: one(users, {
    fields: [comments.userId],
    references: [users.id],
  }),

  post: one(posts, {
    fields: [comments.postId],
    references: [posts.id],
  }),

  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
  }),

  replies: many(comments),
}));

// ⚠️ Your schema uses category as text → not ideal
// 👉 Better:
// categoryId: uuid("category_id").references(() => categories.id)

// Folows relations
// import { categories } from "../schema/categories";

// export const followsRelations = relations(follows, ({ one }) => ({
//   user: one(users, {
//     fields: [follows.userId],
//     references: [users.id],
//   }),

//   category: one(categories, {
//     fields: [follows.categoryId],
//     references: [categories.id],
//   }),
// }));

export const followsRelations = relations(follows, ({ one }) => ({
  user: one(users, {
    fields: [follows.userId],
    references: [users.id],
  }),

  category: one(categories, {
    fields: [follows.categoryId],
    references: [categories.id],
  }),
}));

// user behaviour relations
export const userBehaviorRelations = relations(userBehavior, ({ one }) => ({
  user: one(users, {
    fields: [userBehavior.userId],
    references: [users.id],
  }),

  category: one(categories, {
    fields: [userBehavior.categoryId],
    references: [categories.id],
  }),
}));
