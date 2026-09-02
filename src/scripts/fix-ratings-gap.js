// src/scripts/fix-ratings-gap.js
//
// One-off targeted fix: some movies were posted (and marked as sent) AFTER
// the metadata schema upgrade but BEFORE the rotten_tomatoes/metacritic
// columns were added. Their Telegram post correctly showed RT/Metacritic
// (since that data came straight from the live OMDb call at post time), but
// the DB row silently dropped it because the columns didn't exist yet.
//
// This script only touches rows that:
//   - already have metadata (title IS NOT NULL)
//   - have an imdb_id to look up
//   - are still missing BOTH rotten_tomatoes and metacritic
//
// It does a lightweight OMDb-only re-fetch (no TMDb, no AI review calls),
// so it's cheap and safe to run once.
//
// Usage:
//   node src/scripts/fix-ratings-gap.js

import 'dotenv/config';
import {
  openDB,
  initDB,
  getMoviesMissingRatings,
  updateMovieRatings,
} from '../db/database.js';
import { fetchOMDbRatings } from '../services/omdb.js';

const CONFIG = {
  delayPerItemMs: 1000, // OMDb-only lookups are cheap, but still pace them gently
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('[RatingsGapFix] Starting...');
  const db = openDB();

  try {
    await initDB(db);

    const movies = await getMoviesMissingRatings(db);
    console.log(`[RatingsGapFix] Found ${movies.length} movie(s) missing RT/Metacritic.`);

    if (movies.length === 0) {
      console.log('[RatingsGapFix] Nothing to do.');
      return;
    }

    let fixed = 0;
    let stillMissing = 0;
    let failed = 0;

    for (const movie of movies) {
      try {
        const omdb = await fetchOMDbRatings(movie.imdb_id);

        // Not every movie actually HAS RT/Metacritic data on OMDb — some
        // genuinely don't. Only count it as "fixed" if we got something back.
        if (omdb.rottenTomatoes || omdb.metacritic) {
          fixed++;
        } else {
          stillMissing++;
        }

        await updateMovieRatings(db, movie.id, omdb);
        console.log(`  [RatingsGapFix] Movie ID ${movie.id}: RT=${omdb.rottenTomatoes}, MC=${omdb.metacritic}`);
      } catch (err) {
        failed++;
        console.error(`  [RatingsGapFix] Failed for movie ID ${movie.id}:`, err.message);
      }
      await sleep(CONFIG.delayPerItemMs);
    }

    console.log(`[RatingsGapFix] Done. Updated with data: ${fixed}, genuinely no RT/MC on OMDb: ${stillMissing}, failed: ${failed}, total: ${movies.length}.`);
  } catch (err) {
    console.error('[RatingsGapFix] Fatal error:', err);
    process.exit(1);
  }
})();