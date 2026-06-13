import type { SummaryResult } from "@/types";

// MAY NEED TO IMPORT .ENV FILE HERE.

// ── Validate env at module load ────────────────────────────────────────────────
// FIX: original had no validation — OPENAI_KEY errors only surfaced at
//      runtime during the AI step, wasting all prior scraping work.

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY environment variable is not set. " +
      "Add it to your .env file before starting the server.",
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

// ── Retry with exponential backoff ────────────────────────────────────────────
// FIX: original had no retry — a single OpenAI timeout silently fell back
//      to content.slice(0, 200) for the entire batch without any retry.

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}

// ── Batch summarize articles ───────────────────────────────────────────────────
//
// FIX 1: Prompt didn't specify JSON shape — GPT returned varied structures
//        like {"summaries": [...]} or [{index, summary}] depending on mood.
//        The new prompt locks down the exact schema with a typed example.
//
// FIX 2: safeParse silently returned null on any JSON error, then the
//        catch block fell back without logging what went wrong.
//
// FIX 3: No retry — any network hiccup wiped out the entire batch summary.
//
// FIX 4: OPENAI_KEY → OPENAI_API_KEY (correct env var name for OpenAI SDK).
//
// FIX 5: axios replaced with native fetch (one fewer dependency).

export async function batchSummarize(
  contents: string[],
): Promise<SummaryResult[]> {
  if (contents.length === 0) return [];

  // Trim each content to stay within token limits
  const trimmed = contents.map((c) => c.slice(0, 1500));

  const prompt = trimmed
    .map((c, i) => `Article ${i + 1}:\n${c}`)
    .join("\n\n---\n\n");

  // FIX: Explicit JSON schema in the prompt prevents hallucinated structures
  const systemPrompt = `
You are a news summarization assistant.
Summarize each article in exactly 3 clear, factual sentences, make it SEO friendly.

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
The array must have exactly ${contents.length} objects in this exact shape:
[
  { "index": 1, "summary": "First sentence. Second sentence." },
  { "index": 2, "summary": "First sentence. Second sentence." }
]
`.trim();

  try {
    const result = await withRetry(async () => {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.3, // lower = more consistent JSON output
            max_tokens: contents.length * 80, // ~80 tokens per summary
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ] satisfies OpenAIMessage[],
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as OpenAIResponse;
      const raw = data.choices[0]?.message?.content?.trim();

      if (!raw) throw new Error("OpenAI returned empty content");

      // FIX: strip accidental markdown code fences before parsing
      const clean = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");

      const parsed = JSON.parse(clean) as SummaryResult[];

      if (!Array.isArray(parsed)) {
        throw new Error(`Expected array, got: ${typeof parsed}`);
      }

      return parsed;
    });

    // Validate every item has the required shape
    return contents.map((content, i) => {
      const item = result.find((r) => r.index === i + 1);

      if (item?.summary && typeof item.summary === "string") {
        return { index: i + 1, summary: item.summary };
      }

      // Graceful per-item fallback
      console.warn(
        `[ai] Missing summary for article ${i + 1}, using truncated content`,
      );
      return { index: i + 1, summary: content.slice(0, 200) };
    });
  } catch (err) {
    // Full batch fallback — log the real error
    console.error("[ai] batchSummarize failed after retries:", err);
    return contents.map((content, i) => ({
      index: i + 1,
      summary: content.slice(0, 200),
    }));
  }
}
