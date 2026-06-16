Likes Table
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

Bookmark Table
db/schema/bookmarks.ts
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