import 'dotenv/config';

export const TOKEN = process.env.BOT_TOKEN;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const CHAT_ID = process.env.CHAT_ID;
export const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : null;
export const OMDB_API_KEY = process.env.OMDB_API_KEY;

export const LANGUAGE = process.env.TMDB_LANGUAGE || 'en-US';
export const REGION = process.env.TMDB_REGION || 'US';

export const PRIORITY_YEARS = [2026, 2025, 2024, 2023];
export const FALLBACK_YEARS = [
  2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009,
  2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022
];

export const MIN_IMDB_VOTES = 1000;
export const MIN_IMDB_RATING = 6.5;
export const PRIO_IMDB_RATING = 7.0;
export const MAX_FETCH_ATTEMPTS = 10;

export const TMDB_BASE = 'https://api.themoviedb.org/3';
export const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';
export const TELEGRAM_BASE = `https://api.telegram.org/bot${TOKEN}`;

// Validate required environment variables immediately
const REQUIRED_ENV = { TOKEN, TMDB_API_KEY, OPENAI_API_KEY, CHAT_ID, OMDB_API_KEY, ADMIN_USER_ID };
for (const [key, val] of Object.entries(REQUIRED_ENV)) {
  if (!val) {
    console.error(`[Config] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}