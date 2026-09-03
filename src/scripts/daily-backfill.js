// src/scripts/daily-backfill.js
//
// Daily quota-based backfill, intended to be run once per day via cron.
// Selects up to DAILY_LIMIT movies that are missing metadata, RT/Metacritic,
// and/or a review — then, for EACH movie individually, only calls the APIs
// needed to fill whatever is actually missing. Already-present fields are
// never re-fetched, so no wasted TMDb/OMDb/Brave/Jina/OpenAI calls.
//
// Intended for cron, e.g. once a day at 4am:
//   0 4 * * * cd /root/MovRecomm && /usr/bin/node src/scripts/daily-backfill.js >> /var/log/movrecomm-backfill.log 2>&1
//
// Logs are intentionally compact (one line per movie, one summary line) —
// this is meant to run unattended and be skimmed, not read like a live bot.

import 'dotenv/config';
import {
  openDB,
  initDB,
  getMoviesNeedingAnyBackfill,
  updateMovieMetadata,
  updateMovieRatings,
  updateMovieTrailer,
  saveMovieReview,
} from '../db/database.js';
import { fetchMovieDetails } from '../services/tmdb.js';
import { fetchOMDbRatings } from '../services/omdb.js';

const DAILY_LIMIT = 5;

// ── Required API keys (fail fast) ──
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const JINA_API_KEY = process.env.JINA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is missing from .env');
if (!JINA_API_KEY) throw new Error('JINA_API_KEY is missing from .env');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing from .env');

const CONFIG = {
  delayPerItemMs: 3000,
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

// ── Duplicated review-generation internals (kept in sync with movieReview.js / backfill.js) ──

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
      await sleep(delay);
    } catch (error) {
      if (attempt >= CONFIG.maxRetries) throw error;
      const delay = CONFIG.initialRetryDelayMs * Math.pow(2, attempt);
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
    '  "title": string,\n' +
    '  "persianTitle": string,\n' +
    '  "posterUrl": string | null,\n' +
    '  "imdbRating": string | null,\n' +
    '  "spoilerFree": {\n' +
    '    "overview": string,\n' +
    '    "pros": string[],\n' +
    '    "cons": string[],\n' +
    '    "verdict": string\n' +
    '  },\n' +
    '  "spoilers": {\n' +
    '    "analysis": string,\n' +
    '    "pros": string[],\n' +
    '    "cons": string[],\n' +
    '    "verdict": string\n' +
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
  }, 'OpenAI (Daily Backfill)');

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw);

  if (!parsed.spoilerFree || !parsed.spoilers) {
    throw new Error(`OpenAI response missing required sections. Got keys: ${Object.keys(parsed).join(', ')}`);
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

async function generateReview(imdbId) {
  const movieUrl = `https://www.imdb.com/title/${imdbId}/`;
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
      continue;
    }
  }

  if (scrapedSources.length === 0) {
    throw new Error('No pages could be scraped for review generation.');
  }

  return generateTelegramReviewJson(imdbId, scrapedSources);
}

// ── Per-movie gap-filling: only calls what's actually missing ──

async function processMovie(db, movie) {
  const gaps = [];
  const filled = [];

  // 1. Metadata gap — only hit TMDb if title is genuinely missing.
  let imdbId = movie.imdb_id;
  if (!movie.title) {
    gaps.push('metadata');
    const details = await fetchMovieDetails(movie.id);
    if (!details) throw new Error('TMDb returned no details');

    imdbId = details.imdb_id || imdbId;

    // RT/MC and trailer both piggyback on this same TMDb+OMDb call.
    const omdb = imdbId ? await fetchOMDbRatings(imdbId) : { imdbRating: null, imdbVotes: null, rottenTomatoes: null, metacritic: null };
    await updateMovieMetadata(db, details, details, omdb);
    filled.push('metadata', 'ratings', 'trailer');
  } else {
    if (!movie.rotten_tomatoes && !movie.metacritic) {
      // 2. RT/MC gap only (metadata already present) — lightweight OMDb-only call.
      gaps.push('ratings');
      if (imdbId) {
        const omdb = await fetchOMDbRatings(imdbId);
        await updateMovieRatings(db, movie.id, omdb);
        filled.push('ratings');
      }
    }

    if (!movie.trailer_key) {
      // 3. Trailer gap only (metadata already present) — lightweight TMDb-only call.
      gaps.push('trailer');
      const details = await fetchMovieDetails(movie.id);
      if (details) {
        const trailerKey = details.videos?.results?.find((v) => v.type === 'Trailer' && v.site === 'YouTube')?.key ?? null;
        await updateMovieTrailer(db, movie.id, trailerKey);
        filled.push('trailer');
      }
    }
  }

  // 4. Review gap — only hit Brave/Jina/OpenAI if no review row exists yet.
  if (!movie.has_review) {
    gaps.push('review');
    if (imdbId) {
      const review = await generateReview(imdbId);
      await saveMovieReview(db, movie.id, JSON.stringify(review));
      filled.push('review');
    }
  }

  return { gaps, filled };
}

// ── Entry point ──

(async () => {
  const startedAt = new Date().toISOString();
  console.log(`[DailyBackfill] ${startedAt} — starting, quota: ${DAILY_LIMIT}`);

  const db = openDB();
  try {
    await initDB(db);

    const movies = await getMoviesNeedingAnyBackfill(db, DAILY_LIMIT);
    if (movies.length === 0) {
      console.log('[DailyBackfill] Nothing left to backfill. All movies complete.');
      return;
    }

    let ok = 0;
    let failed = 0;

    for (const movie of movies) {
      try {
        const { gaps, filled } = await processMovie(db, movie);
        console.log(`[DailyBackfill] Movie ${movie.id}: gaps=[${gaps.join(',')}] filled=[${filled.join(',')}]`);
        ok++;
      } catch (err) {
        failed++;
        console.error(`[DailyBackfill] Movie ${movie.id} FAILED: ${err.message}`);
      }
      await sleep(CONFIG.delayPerItemMs);
    }

    console.log(`[DailyBackfill] Done. ok=${ok} failed=${failed} quota=${DAILY_LIMIT}`);
  } catch (err) {
    console.error('[DailyBackfill] Fatal error:', err);
    process.exit(1);
  } finally {
    process.exit(0); // ensure the pool doesn't keep the process alive under cron
  }
})();