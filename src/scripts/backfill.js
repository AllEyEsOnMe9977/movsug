// src/scripts/backfill.js
//
// Standalone, resumable backfill script.
// Fills in missing metadata (from TMDb/OMDb) and missing AI reviews
// (Brave + Jina + OpenAI) for old movie rows that predate the schema upgrade.
//
// Safe to stop (Ctrl+C) and re-run at any time — it only ever selects rows
// that are still missing data, so nothing is duplicated or redone.
//
// Usage:
//   node src/scripts/backfill.js metadata   → backfill only movie metadata
//   node src/scripts/backfill.js reviews    → backfill only missing reviews
//   node src/scripts/backfill.js all        → run both, metadata first (default)

import 'dotenv/config';
import {
  openDB,
  initDB,
  getMoviesMissingMetadata,
  getMoviesMissingReviews,
  updateMovieMetadata,
  saveMovieReview,
} from '../db/database.js';
import { fetchMovieDetails } from '../services/tmdb.js';
import { fetchOMDbRatings } from '../services/omdb.js';

// ── Required API keys (fail fast, same convention as movieReview.js) ──
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const JINA_API_KEY = process.env.JINA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is missing from .env');
if (!JINA_API_KEY) throw new Error('JINA_API_KEY is missing from .env');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing from .env');

// ── Pacing configuration — tune these to control how gentle the script is ──
const CONFIG = {
  batchSize: 20,              // movies processed per batch
  delayPerItemMs: 3000,       // delay between each movie within a batch
  delayPerBatchMs: 60_000,    // longer delay between batches
  // --- copied exactly from movieReview.js CONFIG, kept in sync intentionally ---
  braveResultLimit: 10,
  maxUrlsToScrape: 3,
  domainDelayMs: 1500,
  maxRetries: 3,
  initialRetryDelayMs: 2000,
  maxContentLength: 100_000,
  openaiModel: 'gpt-5.4-mini',
  language: 'Persian',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// Duplicated review-generation internals from movieReview.js
// (kept as an exact behavioral copy per explicit instruction — do not drift
// from movieReview.js without updating both files)
// ────────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, label = 'request') {
  const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (!RETRYABLE_STATUSES.includes(response.status)) {
        throw new Error(`${label} failed: HTTP ${response.status}\n${await response.text()}`);
      }
      if (attempt === CONFIG.maxRetries) {
        throw new Error(`${label} failed after ${CONFIG.maxRetries} retries: HTTP ${response.status}\n${await response.text()}`);
      }
      const retryAfter = response.headers.get('retry-after');
      let delay = null;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        delay = !Number.isNaN(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      }
      delay ||= CONFIG.initialRetryDelayMs * Math.pow(2, attempt);
      console.warn(`${label}: HTTP ${response.status}. Retrying in ${delay}ms...`);
      await sleep(delay);
    } catch (error) {
      if (attempt >= CONFIG.maxRetries) throw error;
      const delay = CONFIG.initialRetryDelayMs * Math.pow(2, attempt);
      console.warn(`${label}: ${error.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw new Error(`${label}: unexpected retry failure`);
}

async function braveSearch(query) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(CONFIG.braveResultLimit));
  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': BRAVE_API_KEY,
    }
  }, 'Brave Search');
  return response.json();
}

async function jinaReader(url) {
  const response = await fetchWithRetry(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/plain',
      'Authorization': `Bearer ${JINA_API_KEY}`,
      'X-Retain-Images': 'none',
      'X-With-Links-Summary': 'true'
    }
  }, `Jina (${url})`);
  let content = await response.text();
  if (content.length > CONFIG.maxContentLength) {
    console.warn(`Jina content exceeded ${CONFIG.maxContentLength} chars. Truncating.`);
    content = content.slice(0, CONFIG.maxContentLength);
  }
  return content;
}

async function generateTelegramReviewJson(imdbId, sources) {
  const combinedSources = sources
    .map(({ url, content }) => `SOURCE: ${url}\n\n${content}`)
    .join('\n\n' + '='.repeat(40) + '\n\n');

  const systemPrompt =
    'You are a movie critic assistant. Using ONLY the provided scraped ' +
    'web content, return a SINGLE JSON object (no markdown, no code ' +
    'fences, no commentary) with exactly this shape:\n\n' +
    '{\n' +
    '  "title": string,               // movie title\n' +
    '  "persianTitle": string,        // accurate Persian translation of the movie title\n' +
    '  "posterUrl": string | null,     // a direct image URL found in the sources, else null\n' +
    '  "imdbRating": string | null,    // e.g. "8.8/10", else null\n' +
    '  "spoilerFree": {\n' +
    '    "overview": string,           // 1-2 short paragraphs: premise, tone, cast (NO plot twists or ending)\n' +
    '    "pros": string[],             // 3-5 short, punchy bullet points\n' +
    '    "cons": string[],             // 3-5 short, punchy bullet points\n' +
    '    "verdict": string             // 3-4 sentences: a fuller "is this for you" conclusion, with brief reasoning\n' +
    '  },\n' +
    '  "spoilers": {\n' +
    '    "analysis": string,           // 1-2 short paragraphs: the full plot, including twists and ending\n' +
    '    "pros": string[],             // 3-5 short, punchy bullet points\n' +
    '    "cons": string[],             // 3-5 short, punchy bullet points\n' +
    '    "verdict": string             // 3-4 sentences: a fuller final verdict, with brief reasoning\n' +
    '  }\n' +
    '}\n\n' +
    'Do not invent facts not supported by the sources. ' +
    `Write all prose fields (overview, pros, cons, verdict, analysis) in ${CONFIG.language}. ` +
    `Keep it compact and scannable - readers want to decide in under a minute whether to watch. ` +
    `Do NOT write essay-length sections. Bullets should be one line each, not paragraphs. ` +
    `Keep "title" as the movie's official title (do not translate it) and keep "imdbRating" in its original numeric format (e.g. "8.8/10"). ` +
    `Respond with ONLY the raw JSON object.`;

  const userPrompt = `IMDb ID: ${imdbId}\n\nScraped source content:\n\n${combinedSources}`;

  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CONFIG.openaiModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  }, 'OpenAI (Backfill JSON)');

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw);

  // Same guardrail as movieReview.js — never save a malformed review.
  if (!parsed.spoilerFree || !parsed.spoilers) {
    throw new Error(`OpenAI response missing required sections (spoilerFree/spoilers). Got keys: ${Object.keys(parsed).join(', ')}`);
  }

  return parsed;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const lastRequestByDomain = new Map();
async function waitForDomain(domain) {
  const lastRequest = lastRequestByDomain.get(domain);
  if (lastRequest) {
    const remaining = CONFIG.domainDelayMs - (Date.now() - lastRequest);
    if (remaining > 0) await sleep(remaining);
  }
  lastRequestByDomain.set(domain, Date.now());
}

/** Generates a review (Brave → Jina → OpenAI) and saves it. Does NOT send to Telegram. */
async function generateAndSaveReview(db, imdbId, movieId) {
  const movieUrl = `https://www.imdb.com/title/${imdbId}/`;
  console.log(`  [Review] Searching Brave for: ${movieUrl}`);

  const search = await braveSearch(movieUrl);
  const results = search.web?.results ?? [];

  const urlsToScrape = results
    .filter((result) => isValidHttpUrl(result.url))
    .slice(0, CONFIG.maxUrlsToScrape);

  const scrapedSources = [];
  for (const result of urlsToScrape) {
    const { url } = result;
    const domain = new URL(url).hostname;
    try {
      await waitForDomain(domain);
      const content = await jinaReader(url);
      scrapedSources.push({ url, content });
    } catch (error) {
      console.error(`  [Review] Could not scrape ${url}: ${error.message}`);
      continue;
    }
  }

  if (scrapedSources.length === 0) {
    throw new Error('No pages could be scraped - cannot generate AI review.');
  }

  const review = await generateTelegramReviewJson(imdbId, scrapedSources);
  await saveMovieReview(db, movieId, JSON.stringify(review));
  console.log(`  [Review] Saved review for movie ID: ${movieId}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Batch runner — generic over a list of work items and a per-item handler
// ────────────────────────────────────────────────────────────────────────────

async function runInBatches(items, handler, label) {
  const total = items.length;
  console.log(`[Backfill:${label}] ${total} item(s) to process. Batch size: ${CONFIG.batchSize}, ` +
    `per-item delay: ${CONFIG.delayPerItemMs}ms, per-batch delay: ${CONFIG.delayPerBatchMs}ms.`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < total; i += CONFIG.batchSize) {
    const batch = items.slice(i, i + CONFIG.batchSize);
    const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
    const totalBatches = Math.ceil(total / CONFIG.batchSize);
    console.log(`[Backfill:${label}] Starting batch ${batchNum}/${totalBatches} (${batch.length} items)...`);

    for (const item of batch) {
      try {
        await handler(item);
        processed++;
      } catch (err) {
        failed++;
        console.error(`[Backfill:${label}] Failed on item ${JSON.stringify(item)}:`, err.message);
      }
      await sleep(CONFIG.delayPerItemMs);
    }

    console.log(`[Backfill:${label}] Batch ${batchNum}/${totalBatches} done. Progress: ${processed + failed}/${total} (${failed} failed).`);

    // Skip the batch delay after the very last batch — no point waiting after finishing.
    const isLastBatch = i + CONFIG.batchSize >= total;
    if (!isLastBatch) {
      console.log(`[Backfill:${label}] Sleeping ${CONFIG.delayPerBatchMs}ms before next batch...`);
      await sleep(CONFIG.delayPerBatchMs);
    }
  }

  console.log(`[Backfill:${label}] Complete. Processed: ${processed}, Failed: ${failed}, Total: ${total}.`);
}

// ────────────────────────────────────────────────────────────────────────────
// Task implementations
// ────────────────────────────────────────────────────────────────────────────

async function backfillMetadata(db) {
  const movieIds = await getMoviesMissingMetadata(db);

  if (movieIds.length === 0) {
    console.log('[Backfill:metadata] Nothing to do — all rows already have metadata.');
    return;
  }

  await runInBatches(movieIds, async (movieId) => {
    const details = await fetchMovieDetails(movieId);
    if (!details) {
      throw new Error(`TMDb returned no details for movie ${movieId}`);
    }

    // `movies` expects a TMDb "movie result"-shaped object (title, overview, etc.)
    // `fetchMovieDetails` returns that same shape directly, so it doubles as both
    // `movie` and `details` for the purposes of updateMovieMetadata().
    const omdb = await fetchOMDbRatings(details.imdb_id);

    await updateMovieMetadata(db, details, details, omdb);
    console.log(`  [Metadata] Updated movie ID: ${movieId} ("${details.title}")`);
  }, 'metadata');
}

async function backfillReviews(db) {
  const movies = await getMoviesMissingReviews(db);

  // Reviews require an imdb_id — skip any row where metadata hasn't been backfilled yet.
  const eligible = movies.filter((m) => m.imdb_id);
  const skipped = movies.length - eligible.length;
  if (skipped > 0) {
    console.warn(`[Backfill:reviews] Skipping ${skipped} movie(s) with no imdb_id (run metadata backfill first).`);
  }

  if (eligible.length === 0) {
    console.log('[Backfill:reviews] Nothing to do — no eligible movies missing a review.');
    return;
  }

  await runInBatches(eligible, async (movie) => {
    await generateAndSaveReview(db, movie.imdb_id, movie.id);
  }, 'reviews');
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────────

(async () => {
  const mode = process.argv[2] || 'all';
  if (!['metadata', 'reviews', 'all'].includes(mode)) {
    console.error(`Unknown mode "${mode}". Use: metadata | reviews | all`);
    process.exit(1);
  }

  console.log(`[Backfill] Starting in "${mode}" mode...`);
  const db = openDB();

  try {
    await initDB(db);

    if (mode === 'metadata' || mode === 'all') {
      await backfillMetadata(db);
    }
    if (mode === 'reviews' || mode === 'all') {
      await backfillReviews(db);
    }

    console.log('[Backfill] All requested tasks complete.');
  } catch (err) {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  }
})();