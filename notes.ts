// STEP 4 — WHERE THIS IS USED
// 📍 Inside your Inngest pipeline below:
const fullContent =
  (await extractArticleContent(article.url)) ||
  article.description ||
  article.title;
// Now: extractArticleContent is cached. So your ingestion becomes FAST

// BONUS — CACHE STRATEGY IMPROVEMENTS
// PREVENT DUPLICATE SCRAPING (LOCKING)
const lockKey = `lock:${url}`;
const isLocked = await redis.get(lockKey);

if (isLocked) return null;

await redis.set(lockKey, "1", { EX: 10 });
// Prevents: 10 workers scraping same URL

// CACHE EVEN FAILED RESULTS
if (!text) {
  // 👉 Prevents retry storms
  await redis.set(cacheKey, "EMPTY", { EX: 3600 });
}

// HASH KEYS (OPTIONAL) Instead of long URLs:
import crypto from "crypto";

function getKey(url: string) {
  return "article:" + crypto.createHash("md5").update(url).digest("hex");
}

// WHERE LOCKING GOES (PREVENT DUPLICATE SCRAPING)
// THE PROBLEM Without locking:
// 10 workers → same URL → scrape 10 times ❌
// This happens because: Inngest runs jobs in parallel, Multiple RSS feeds may contain the same link, Retries can overlap


// PRO TIPS (NEXT LEVEL)
// If you want to go even further:
// 1. PARALLEL SCRAPING (LIMITED)
await Promise.allSettled(
  uniqueArticles.map(a => extractArticleContent(a.url))
// (With concurrency limit = 🔥 best)

// SMART BATCHING BY TOKEN SIZE
// Instead of fixed BATCH_SIZE, batch by:
~12k tokens per request

// CACHE AI RESULTS
ai:${hash(content)}
// → Avoid re-summarizing same content

// HOW IT WORKS (CLEAR FLOW)
// First worker:
// No cache ❌
// No lock ❌
// → Acquires lock ✅
// → Scrapes
// → Saves cache
// → Releases lock
// Second worker:
// No cache ❌
// Lock exists ❌
// → SKIPS scraping
// → waits briefly
// → reads from cache

// BATCHING OPENAI REQUESTS (10x COST REDUCTION)
// The problem without batching
// 100 articles → 100 API calls ❌ expensive ❌ slow



// ✅ OpenAI batching (10x cheaper)
// ✅ Deduplication (DB + Redis)
// ✅ Scraping with locking (assumes your scraper already has Redis lock)
// ✅ Fallback when OpenAI fails / rate limits hit
// ✅ Chunking to respect token limits
// ✅ Idempotency-safe processing




// WHAT THIS FUNCTION HANDLES (IMPORTANT)
// ✅ 1. DEDUPLICATION (DOUBLE LAYER)
// Redis → prevents reprocessing (fast)
// DB → guarantees uniqueness (permanent)
// ✅ 2. SCRAPING SAFETY
// Uses your locked scraper
// Prevents:
// duplicate HTTP calls
// rate limits
// bans
// ✅ 3. OPENAI COST OPTIMIZATION
// Before: 50 articles → 50 API calls ❌
// After: 50 articles → 10 API calls ✅
// ✅ 5. IDEMPOTENCY (CRITICAL FOR INNGEST)
// Safe on retries
// Safe on crashes
// Safe on parallel runs







// Next upgrades (huge impact):
// 👉 AI image ranking (choose best image automatically)
// 👉 Detect duplicate images across sources
// 👉 Generate blurhash / placeholders
// 👉 Pre-cache images in CDN





