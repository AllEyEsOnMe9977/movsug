// src/services/movieReview.js
import 'dotenv/config';
import { saveMovieReview, getMovieReview } from '../db/database.js';

// --- Required API keys (fail fast if missing) ---
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const JINA_API_KEY = process.env.JINA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is missing from .env');
if (!JINA_API_KEY) throw new Error('JINA_API_KEY is missing from .env');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing from .env');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing from .env');

/* Configuration */
const CONFIG = {
    braveResultLimit: 10,
    maxUrlsToScrape: 3,
    scrapeConcurrency: 1,
    domainDelayMs: 1500,
    maxRetries: 3,
    initialRetryDelayMs: 2000,
    maxContentLength: 100_000,
    openaiModel: 'gpt-5.4-mini', // Adjusted slightly to the official OpenAI alias, change back to gpt-5.4-mini if you have custom routing
    language: 'Persian',
    telegramRichMessageMaxChars: 32_768,
    telegramFieldMaxChars: 15000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    }, 'OpenAI (Telegram JSON)');

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    return JSON.parse(raw);
}

function truncate(text, maxLength) {
    if (!text || text.length <= maxLength) return text ?? '';
    return text.slice(0, maxLength - 1).trimEnd() + '…';
}

function buildRichMessageBlocks(imdbId, review) {
    const fieldLimit = CONFIG.telegramFieldMaxChars;
    const blocks = [];

    // 0. Header button (inert/disabled label linking to the previous message)
    blocks.push({
        type: 'buttons',
        align: 'center',
        buttons: [
            { text: 'بررسی فیلم بالا', style: 'success', callback_data: 'noop' }
        ]
    });

    if (review.posterUrl) {
        blocks.push({ type: 'photo', photo: { type: 'photo', media: review.posterUrl } });
    }

    blocks.push({
        type: 'table',
        is_bordered: true,
        is_striped: true,
        is_compact: true,
        cells: [
            [
                { type: 'text', text: { type: 'button', button: { text: '🎬 Title', style: 'primary', callback_data: 'noop' } } },
                { type: 'text', text: truncate(review.title, fieldLimit) }
            ],
            [
                { type: 'text', text: { type: 'button', button: { text: '🇮🇷 Farsi', style: 'primary', callback_data: 'noop' } } },
                { type: 'text', text: truncate(review.persianTitle || 'N/A', fieldLimit) }
            ]
        ]
    });

    const spoilerFreeText =
        `${review.spoilerFree.overview}\n\n` +
        `نقاط قوت:\n${review.spoilerFree.pros.map((p) => `+ ${p}`).join('\n')}\n\n` +
        `نقاط ضعف:\n${review.spoilerFree.cons.map((c) => `- ${c}`).join('\n')}\n\n` +
        `نتیجه‌گیری: ${review.spoilerFree.verdict}`;

    blocks.push({ type: 'paragraph', text: '📝 نقد بدون اسپویل' });
    blocks.push({ type: 'expandable_blockquote', text: truncate(spoilerFreeText, fieldLimit) });

    const spoilersBody =
        `${review.spoilers.analysis}\n\n` +
        `نقاط قوت:\n${review.spoilers.pros.map((p) => `+ ${p}`).join('\n')}\n\n` +
        `نقاط ضعف:\n${review.spoilers.cons.map((c) => `- ${c}`).join('\n')}\n\n` +
        `نتیجه‌گیری: ${review.spoilers.verdict}`;

    const spoilersRichText = [{ type: 'spoiler', text: truncate(spoilersBody, fieldLimit) }];

    blocks.push({ type: 'paragraph', text: '⚠️ نقد کامل (با اسپویل)' });
    blocks.push({ type: 'expandable_blockquote', text: spoilersRichText });

    blocks.push({
        type: 'buttons',
        align: 'center',
        buttons: [{ text: '🎬 IMDB', url: `https://www.imdb.com/title/${imdbId}/` }]
    });

    return blocks;
}

// Updated to receive dynamic chatId from the bot index
async function sendTelegramRichMessage(blocks, chatId) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendRichMessage`;

    const post = (blockList) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            rich_message: { blocks: blockList }
        }),
    });

    let response = await post(blocks);
    let result = await response.json();

    if (!result.ok && /failed to get HTTP URL content/i.test(result.description ?? '')) {
        console.warn('Telegram could not fetch the poster image URL. Retrying without the photo block...');
        const blocksWithoutPhoto = blocks.filter((block) => block.type !== 'photo');
        response = await post(blocksWithoutPhoto);
        result = await response.json();
    }
    return result;
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

function isValidHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// Main execution exported for use in index.js
// Added movieId (integer for DB) and db (SQLite connection instance)
export async function processMovie(imdbId, movieId, chatId, db) {
    let telegramReview;

    // 1. THE COST-SAVING GUARDRAIL: Check the DB for an existing review
    const cachedReviewText = await getMovieReview(db, movieId);

    if (cachedReviewText) {
        console.log(`\n[Cache] Found existing review for movie ID: ${movieId}. Skipping AI generation.`);
        try {
            telegramReview = JSON.parse(cachedReviewText);
        } catch (err) {
            console.error('[Cache] Failed to parse cached review, falling back to fresh generation.', err);
        }
    }

    // 2. If no valid cache exists, run the expensive scraping/AI flow
    if (!telegramReview) {
        const movieUrl = `https://www.imdb.com/title/${imdbId}/`;
        console.log(`\nSearching Brave for: ${movieUrl}\n`);

        const search = await braveSearch(movieUrl);
        const results = search.web?.results ?? [];
        
        const urlsToScrape = results
            .filter((result) => isValidHttpUrl(result.url))
            .slice(0, CONFIG.maxUrlsToScrape);

        const scrapedSources = [];
        for (const [index, result] of urlsToScrape.entries()) {
            const { url } = result;
            const domain = new URL(url).hostname;
            try {
                await waitForDomain(domain);
                const content = await jinaReader(url);
                scrapedSources.push({ url, content });
            } catch (error) {
                console.error(`Could not scrape ${url}: ${error.message}`);
                continue;
            }
        }

        if (scrapedSources.length === 0) {
            throw new Error('No pages could be scraped - cannot generate AI review.');
        }

        telegramReview = await generateTelegramReviewJson(imdbId, scrapedSources);

        // Save the freshly generated review to the database
        try {
            await saveMovieReview(db, movieId, JSON.stringify(telegramReview));
            console.log(`\nSaved fresh review to database for movie ID: ${movieId}`);
        } catch (err) {
            console.error('Database save failed:', err);
        }
    }

    // 3. Send the Rich Message to Telegram (happens whether cached or fresh)
    const richMessageBlocks = buildRichMessageBlocks(imdbId, telegramReview);
    const telegramResult = await sendTelegramRichMessage(richMessageBlocks, chatId);

    if (!telegramResult.ok) {
        console.error(`Telegram API rejected the message: ${telegramResult.description}`);
    }

    return { imdbId, review: telegramReview, telegramResult };
}