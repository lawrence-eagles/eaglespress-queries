// Schemas

// APP TABLES
// user
// posts
// sources
// categories
// likes
// bookmarks
// comments
// follows
// user_behavior

// User Table
// db/schema/user.ts
import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(), // from Better Auth

  email: text("email").notNull(),
  name: text("name"),
  image: text("image"),

  // 🔥 YOUR APP FIELDS
  username: text("username"),
  avatarUrl: text("avatar_url"),

  interests: jsonb("interests").$type<string[]>(),

  createdAt: timestamp("created_at").defaultNow(),
});

// Posts Table
// db/schema/posts.ts
import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),

  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  imageUrl: text("image_url"),

  sourceId: uuid("source_id").references(() => sources.id),

  categoryId: uuid("category_id").references(() => categories.id),

  score: integer("score").default(0),

  createdAt: timestamp("created_at").defaultNow(),
});

// Source Table
// db/schema/sources.ts
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),

  name: text("name").notNull(),
  url: text("url"),
  logoUrl: text("logo_url"),
});

// Category table
// db/schema/categories.ts
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(), // e.g. "Technology"
    slug: text("slug").notNull(), // e.g. "technology"

    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("categories_name_idx").on(t.name),
    slugIdx: uniqueIndex("categories_slug_idx").on(t.slug),
  }),
);

// Likes Table
export const likes = pgTable(
  "likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),
  }),
);

// Bookmark Table
// db/schema/bookmarks.ts
import { pgTable, text, uuid, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./user";
import { posts } from "./posts";

export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.postId] }),
  }),
);

// Comments Table
export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),

  content: text("content").notNull(),

  userId: text("user_id").references(() => user.id),
  postId: uuid("post_id").references(() => posts.id),

  parentId: uuid("parent_id"),

  createdAt: timestamp("created_at").defaultNow(),
});

// Follows Table
// db/schema/follows.ts
import { pgTable, text, uuid, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./user";
import { categories } from "./categories";

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
  }),
);

// User behaviour Table
// db/schema/userBehavior.ts
import { pgTable, text, uuid, integer, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./user";
import { categories } from "./categories";

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
  }),
);

// Relations

// User Relations
import { relations } from "drizzle-orm";

export const userRelations = relations(user, ({ many }) => ({
  likes: many(likes),
  bookmarks: many(bookmarks),
  comments: many(comments),
  follows: many(follows),
  behavior: many(userBehavior),
}));

// Post Relations
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

// Category Relations
export const categoriesRelations = relations(categories, ({ many }) => ({
  posts: many(posts),
  followers: many(follows),
  behavior: many(userBehavior),
}));

// 🔁 3. REQUIRED REVERSE RELATIONS (IMPORTANT)

// If you don’t add these, Drizzle won’t fully work.

// POSTS → CATEGORY
// inside postsRelations

// category: one(categories, {
//   fields: [posts.categoryId],
//   references: [categories.id],
// }),
// 🔔 FOLLOWS → CATEGORY
// db/relations/follows.ts

// category: one(categories, {
//   fields: [follows.categoryId],
//   references: [categories.id],
// }),
// 🧠 USER BEHAVIOR → CATEGORY
// db/relations/userBehavior.ts

// category: one(categories, {
//   fields: [userBehavior.categoryId],
//   references: [categories.id],
// }),

// Source Relations generated by copilot
export const sourcesRelations = relations(sources, ({ many }) => ({
  posts: many(posts),
}));

// Likes Relations
export const likesRelations = relations(likes, ({ one }) => ({
  user: one(user, {
    fields: [likes.userId],
    references: [user.id],
  }),

  post: one(posts, {
    fields: [likes.postId],
    references: [posts.id],
  }),
}));

// Comment Relations
export const commentsRelations = relations(comments, ({ one, many }) => ({
  user: one(user, {
    fields: [comments.userId],
    references: [user.id],
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

// Bookmark Relations
// db/relations/bookmarks.ts
import { relations } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks";
import { user } from "../schema/user";
import { posts } from "../schema/posts";

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(user, {
    fields: [bookmarks.userId],
    references: [user.id],
  }),

  post: one(posts, {
    fields: [bookmarks.postId],
    references: [posts.id],
  }),
}));

// Add reverse relations
// in userRelations
// bookmarks: many(bookmarks)

// in postsRelations
// bookmarks: many(bookmarks)

// Follows Relations
// db/relations/follows.ts
import { relations } from "drizzle-orm";
import { follows } from "../schema/follows";
import { user } from "../schema/user";
import { categories } from "../schema/categories";

export const followsRelations = relations(follows, ({ one }) => ({
  user: one(user, {
    fields: [follows.userId],
    references: [user.id],
  }),

  category: one(categories, {
    fields: [follows.categoryId],
    references: [categories.id],
  }),
}));

// Reverse relations
// userRelations
// follows: many(follows)

// categoriesRelations
// followers: many(follows)

// user Behavior Relation
// db/relations/userBehavior.ts
import { relations } from "drizzle-orm";
import { userBehavior } from "../schema/userBehavior";
import { user } from "../schema/user";
import { categories } from "../schema/categories";

export const userBehaviorRelations = relations(userBehavior, ({ one }) => ({
  user: one(user, {
    fields: [userBehavior.userId],
    references: [user.id],
  }),

  category: one(categories, {
    fields: [userBehavior.categoryId],
    references: [categories.id],
  }),
}));

// 🔁 Reverse relations
// userRelations
// behavior: many(userBehavior)

// categoriesRelations
// behavior: many(userBehavior)

// UPDATE POSTS SCHEMA (ADD SLUG + CLICKS)
// /db/schema/posts.ts
import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),

  title: text("title").notNull(),
  slug: text("slug").unique(), // ✅ NEW (SEO)

  description: text("description"),
  url: text("url").notNull(),
  imageUrl: text("image_url"),

  source: text("source"),
  category: text("category"),

  score: integer("score").default(0),

  clicks: integer("clicks").default(0), // ✅ NEW

  createdAt: timestamp("created_at").defaultNow(),
});
