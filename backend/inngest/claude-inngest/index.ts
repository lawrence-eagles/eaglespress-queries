// ── Raw article from RSS feed ──────────────────────────────────────────────────

export interface RawArticle {
  title: string
  url: string
  description: string
  imageUrl: string | null
  feedUrl: string
  publishedAt: Date | null
}

// ── After scraping ─────────────────────────────────────────────────────────────

export interface ScrapedArticle extends RawArticle {
  content: string
  imageUrl: string | null // overwritten after OG scrape
}

// ── After AI enrichment ────────────────────────────────────────────────────────

export interface EnrichedArticle extends ScrapedArticle {
  summary: string
}

// ── AI summary response shape ──────────────────────────────────────────────────

export interface SummaryResult {
  index: number
  summary: string
}

// ── Score inputs ───────────────────────────────────────────────────────────────

export interface ScoreInput {
  title: string
  content: string
  hasImage: boolean
  publishedAt: Date | null
}
