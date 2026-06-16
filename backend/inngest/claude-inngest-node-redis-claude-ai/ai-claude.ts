import type { SummaryResult } from "@/types";

// ── Validate env at module load ────────────────────────────────────────────────
//
// BUG FIX: was checking OPENAI_API_KEY — this codebase uses Claude (Anthropic).
// Fail loudly at startup rather than silently mid-pipeline after wasting
// scraping and DB budget on articles that can't be summarized.

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY environment variable is not set.\n" +
      "Add it to your .env file before starting the server.",
  );
}

// ── Anthropic API response types ───────────────────────────────────────────────
//
// BUG FIX: was using OpenAIResponse / OpenAIMessage types which have a completely
// different shape from the Anthropic API:
//
//   OpenAI response:   { choices: [{ message: { content: "..." } }] }
//   Anthropic response: { content: [{ type: "text", text: "..." }], stop_reason, usage }
//
// Using the wrong type meant response.choices[0]?.message?.content was always
// undefined when called against api.anthropic.com, causing every batch to fall
// back to the truncated content without any error being thrown.

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ── Retry with exponential backoff ────────────────────────────────────────────
// Handles transient network failures and Anthropic 529 (overloaded) responses.

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
        await new Promise((r) =>
          setTimeout(r, delayMs * Math.pow(2, attempt)),
        );
      }
    }
  }

  throw lastError;
}

// ── Batch summarize articles using Claude ─────────────────────────────────────
//
// Full list of bugs fixed in this function:
//
// BUG 1: Wrong env var — OPENAI_API_KEY → ANTHROPIC_API_KEY
//
// BUG 2: Wrong API endpoint
//   BEFORE: https://api.openai.com/v1/chat/completions
//   AFTER:  https://api.anthropic.com/v1/messages
//
// BUG 3: Wrong auth header
//   BEFORE: Authorization: Bearer ${process.env.OPENAI_API_KEY}
//   AFTER:  x-api-key: ${process.env.ANTHROPIC_API_KEY}
//   The anthropic-version header is also required — missing it returns 400.
//
// BUG 4: Wrong request body shape
//   BEFORE: { model, messages: [{role:"system",...}, {role:"user",...}] }
//   AFTER:  { model, max_tokens, system: "...", messages: [{role:"user",...}] }
//   The Claude API takes `system` as a TOP-LEVEL STRING field, not as a message
//   with role:"system". Passing role:"system" inside messages[] returns a 400.
//
// BUG 5: Wrong model name
//   BEFORE: "gpt-4o-mini"
//   AFTER:  "claude-sonnet-4-6"
//
// BUG 6: Wrong response parsing path
//   BEFORE: data.choices[0]?.message?.content  (OpenAI shape)
//   AFTER:  data.content.find(b => b.type === "text")?.text  (Anthropic shape)
//
// BUG 7: Wrong error message strings ("OpenAI" → "Anthropic" / "Claude")
//
// BUG 8: Wrong type interfaces (OpenAIMessage, OpenAIResponse → AnthropicResponse)

export async function batchSummarize(
  contents: string[],
): Promise<SummaryResult[]> {
  if (contents.length === 0) return [];

  // Trim each content to stay within token limits (~375 tokens at 4 chars/token)
  const trimmed = contents.map((c) => c.slice(0, 1_500));

  const userPrompt = trimmed
    .map((c, i) => `Article ${i + 1}:\n${c}`)
    .join("\n\n---\n\n");

  // BUG FIX: system is a top-level field in the Anthropic API.
  // Explicit JSON schema prevents hallucinated response structures.
  const systemPrompt = `
You are a news summarization assistant for Eaglespress, a news aggregator app.
Summarize each article in exactly 3 clear, factual, SEO-friendly sentences.

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
The array must have exactly ${contents.length} objects in this exact shape:
[
  { "index": 1, "summary": "Sentence one. Sentence two. Sentence three." },
  { "index": 2, "summary": "Sentence one. Sentence two. Sentence three." }
]
`.trim();

  try {
    const result = await withRetry(async () => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type":      "application/json",
          // BUG FIX: Anthropic uses x-api-key, not "Authorization: Bearer ..."
          "x-api-key":         process.env.ANTHROPIC_API_KEY!,
          // BUG FIX: anthropic-version is required — omitting it returns 400
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // BUG FIX: correct Claude model
          model:      "claude-sonnet-4-6",
          max_tokens: Math.max(contents.length * 120, 512),
          // BUG FIX: system is a top-level string field in the Anthropic API,
          // NOT a { role: "system", content: "..." } entry in messages[].
          // Putting role:"system" inside messages[] causes a 400 error.
          system:   systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        // BUG FIX: was "OpenAI API error"
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as AnthropicResponse;

      // BUG FIX: was data.choices[0]?.message?.content (OpenAI shape)
      // Claude returns content[] array of typed blocks — find the text block
      const textBlock = data.content.find((b) => b.type === "text");
      const raw       = textBlock?.text?.trim();

      if (!raw) {
        // BUG FIX: was "OpenAI returned empty content"
        throw new Error("Claude returned empty content");
      }

      // Strip accidental markdown code fences — model sometimes adds them
      // despite explicit instructions not to
      const clean = raw
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(clean) as SummaryResult[];

      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array, got: ${typeof parsed}`);
      }

      if (parsed.length !== contents.length) {
        throw new Error(
          `Expected ${contents.length} summaries, got ${parsed.length}`,
        );
      }

      return parsed;
    });

    // Validate every item — fall back per-item if Claude skipped one
    return contents.map((content, i) => {
      const item = result.find((r) => r.index === i + 1);

      if (item?.summary && typeof item.summary === "string") {
        return { index: i + 1, summary: item.summary };
      }

      console.warn(`[ai] Missing summary for article ${i + 1}, using fallback`);
      return { index: i + 1, summary: content.slice(0, 200) };
    });
  } catch (err) {
    // Full batch fallback — log real error, return truncated content
    console.error("[ai] batchSummarize failed after retries:", err);
    return contents.map((content, i) => ({
      index:   i + 1,
      summary: content.slice(0, 200),
    }));
  }
}
