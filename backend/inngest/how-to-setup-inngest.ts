// EXPRESS PROJECT STRUCTURE (Recommended)
// src/
// ├── server.ts                # Express entry
// ├── routes/
// │   └── posts.ts            # API routes
// ├── services/
// │   ├── fetchNews.ts        # ✅ your inngest job
// │   ├── scraper.ts
// │   ├── ai.ts
// │   ├── source.ts
// │   ├── category.ts
// │   └── score.ts
// ├── utils/
// │   └── slug.ts
// ├── lib/
// │   ├── inngest.ts          # inngest client
// │   └── redis.ts
// ├── db/
// │   └── schema.ts

// STEP 1: Setup Inngest in Express
// /lib/inngest.ts
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "news-app" });

// EXPRESS SERVER SETUP
// /server.ts
import express from "express";
import { serve } from "inngest/express";

import { inngest } from "./lib/inngest";
import { fetchNews } from "./services/fetchNews";

import postsRouter from "./routes/posts";

const app = express();
app.use(express.json());

// ✅ Your API routes
app.use("/api/posts", postsRouter);

// ✅ Inngest endpoint (VERY IMPORTANT)
app.use(
  "/api/inngest",
  serve({
    client: inngest,
    functions: [fetchNews], // register your job
  }),
);

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
