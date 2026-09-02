import { 
  PRIORITY_YEARS, FALLBACK_YEARS, MAX_FETCH_ATTEMPTS, 
  MIN_IMDB_VOTES, MIN_IMDB_RATING, PRIO_IMDB_RATING,
  ADMIN_USER_ID, CHAT_ID 
} from './config/env.js';
import { processMovie } from './services/movieReview.js';
import { openDB, initDB, isMovieSent, markMovieAsSent } from './db/database.js';
import { fetchTotalPages, fetchMoviePage, fetchMovieDetails, fetchMovieByImdbId } from './services/tmdb.js';
import { fetchOMDbRatings } from './services/omdb.js';
import { translateToPersian } from './services/openai.js';
import { sendRichMoviePost, tgSendMessage, getUpdates } from './services/telegram.js';
import { buildRichBlocks } from './utils/messageBuilder.js';

// In-memory state tracking for multi-step admin input
const userStates = new Map();

/**
 * Shared pipeline to translate, build blocks, send to channel, and record in DB.
 */
async function processAndSendMovie(db, movie, details, omdb) {
  const translatedOverview = await translateToPersian(movie.overview, details);
  const blocks = buildRichBlocks(movie, details, translatedOverview, omdb);
  
  // 1. Send the main movie details first
  try {
    await sendRichMoviePost(movie, blocks);
    console.log(`[Post] Main details sent for ${movie.id}. Initiating review process...`);
  } catch (err) {
    console.error(`[Post] Fatal error: Main details failed to send for ${movie.id}. Aborting.`, err.message);
    throw err;
  }

  // 2. Mark as sent immediately — must happen before the review step,
  // since `reviews.movie_id` now has a foreign key referencing `movies.id`.
  await markMovieAsSent(db, movie, details, omdb);
  console.log(`[Post] Movie ${movie.id} ("${movie.title}") recorded in database.`);

  // 3. The Curveball Handler: Generate, save, and send the review
  if (details.imdb_id) {
    try {
      await processMovie(details.imdb_id, movie.id, CHAT_ID, db);
    } catch (err) {
      console.error(`[Post] Review generation/sending failed for ${movie.id}:`, err.message);
    }
  } else {
    console.warn(`[Post] No IMDb ID found for movie ${movie.id}. Skipping review.`);
  }
}

/**
 * Handles manual movie posting initiated by the admin via IMDb ID.
 */
async function handleManualPost(db, imdbId, adminChatId) {
  const cleanId = imdbId.trim();
  if (!/^tt\d+$/i.test(cleanId)) {
    await tgSendMessage(adminChatId, '❌ شناسه IMDb نامعتبر است. فرمت صحیح: tt2106476');
    return;
  }

  await tgSendMessage(adminChatId, `⏳ در حال پردازش فیلم با شناسه ${cleanId}...`);

  try {
    const tmdbMovie = await fetchMovieByImdbId(cleanId);
    if (!tmdbMovie) {
      await tgSendMessage(adminChatId, `❌ فیلمی در TMDb با شناسه ${cleanId} یافت نشد.`);
      return;
    }

    // Prevent duplicate manual posts
    if (await isMovieSent(db, tmdbMovie.id)) {
      await tgSendMessage(adminChatId, `⚠️ این فیلم قبلاً در کانال ارسال شده است ("${tmdbMovie.title}").`);
      return;
    }

    const details = await fetchMovieDetails(tmdbMovie.id);
    if (!details) {
      await tgSendMessage(adminChatId, '❌ دریافت جزئیات فیلم از TMDb ناموفق بود.');
      return;
    }

    const omdb = await fetchOMDbRatings(cleanId);
    await processAndSendMovie(db, tmdbMovie, details, omdb);
    await tgSendMessage(adminChatId, `✅ فیلم "${tmdbMovie.title}" با موفقیت ارسال و در دیتابیس ثبت شد.`);
  } catch (err) {
    console.error(`[ManualPost] Error processing ${cleanId}:`, err.message);
    await tgSendMessage(adminChatId, `❌ خطا در پردازش و ارسال: ${err.message}`);
  }
}

/**
 * Tries to find an unsent movie from the given year list, then posts it.
 */
async function tryYears(db, years, totalPages) {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const page = Math.floor(Math.random() * totalPages) + 1;
    console.log(`[Fetch] Attempt ${attempt}/${MAX_FETCH_ATTEMPTS} — page ${page}, years: [${years}]`);

    let movies;
    try {
      movies = await fetchMoviePage(page);
    } catch (err) {
      console.error(`[Fetch] Failed to fetch page ${page}:`, err.message);
      continue;
    }

    const candidates = movies.filter((m) => {
      const year = parseInt((m.release_date || '0').split('-')[0], 10);
      return years.includes(year) && m.overview;
    });

    candidates.sort((a, b) => {
      const aHigh = a.vote_average >= PRIO_IMDB_RATING ? 1 : 0;
      const bHigh = b.vote_average >= PRIO_IMDB_RATING ? 1 : 0;
      return bHigh - aHigh;
    });

    for (const movie of candidates) {
      if (await isMovieSent(db, movie.id)) {
        continue;
      }

      const details = await fetchMovieDetails(movie.id);
      if (!details) continue;

      const omdb = await fetchOMDbRatings(details.imdb_id);
      if (omdb.imdbVotes !== null && omdb.imdbVotes < MIN_IMDB_VOTES) continue;
      if (omdb.imdbRating !== null && omdb.imdbRating < MIN_IMDB_RATING) continue;

      await processAndSendMovie(db, movie, details, omdb);
      return true;
    }
  }

  return false; 
}

/**
 * Automated posting logic.
 */
export async function fetchAndSendMovie(db) {
  const totalPages = await fetchTotalPages();
  console.log('[Run] Trying priority years:', PRIORITY_YEARS);
  let sent = await tryYears(db, PRIORITY_YEARS, totalPages);

  if (!sent) {
    console.log('[Run] No match in priority years. Trying fallback years:', FALLBACK_YEARS);
    sent = await tryYears(db, FALLBACK_YEARS, totalPages);
  }

  if (!sent) {
    console.warn('[Run] No valid unsent movie found after all attempts.');
  }

  return sent;
}

/**
 * Long-polling loop to process incoming admin commands.
 */
async function startPolling(db) {
  let offset = 0;
  console.log('[Polling] Command listener started.');

  while (true) {
    try {
      const updates = await getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg || !msg.text) continue;

        // Verify admin authorization
        if (msg.from?.id !== ADMIN_USER_ID) {
          console.warn(`[Auth] Unauthorized access attempt from user ID: ${msg.from?.id}`);
          continue;
        }

        const text = msg.text.trim();
        const chatId = msg.chat.id;

        // Command: /p tt1234567 (Single line)
        const directMatch = text.match(/^\/p\s+(tt\d+)$/i);
        if (directMatch) {
          userStates.delete(chatId);
          await handleManualPost(db, directMatch[1], chatId);
          continue;
        }

        // Command: /p (Awaiting next message with ID)
        if (text === '/p') {
          userStates.set(chatId, 'AWAITING_IMDB_ID');
          await tgSendMessage(chatId, '🎬 لطفاً شناسه IMDb فیلم را ارسال کنید (مثال: `tt2106476`):', { parse_mode: 'Markdown' });
          continue;
        }

        // Handle awaited IMDb ID input
        if (userStates.get(chatId) === 'AWAITING_IMDB_ID') {
          userStates.delete(chatId);
          await handleManualPost(db, text, chatId);
          continue;
        }
      }
    } catch (err) {
      console.error('[Polling] Error in polling loop:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Application entry point
// ────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[Startup] Bot initializing...');
  const db = openDB();

  try {
    await initDB(db);

    // Start listening for admin commands continuously
    startPolling(db);

    // Run the automated fetcher every 6 hours
    setInterval(() => fetchAndSendMovie(db), 6 * 60 * 60 * 1000);
    
    // Also run it immediately on startup (optional, remove if you only want it on the interval)
    fetchAndSendMovie(db);
  } catch (err) {
    console.error('[Startup] Fatal initialization error:', err);
    process.exit(1);
  }
})();