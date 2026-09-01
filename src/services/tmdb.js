import axios from 'axios';
import { TMDB_BASE, TMDB_API_KEY, LANGUAGE, REGION } from '../config/env.js';

export async function fetchTotalPages() {
  const url = `${TMDB_BASE}/movie/top_rated?api_key=${TMDB_API_KEY}&language=${LANGUAGE}&region=${REGION}&page=1`;
  try {
    const { data } = await axios.get(url);
    console.log(`[TMDb] Total pages available: ${data.total_pages}`);
    return data.total_pages;
  } catch (err) {
    console.error('[TMDb] Failed to fetch total pages, defaulting to 1:', err.message);
    return 1;
  }
}

export async function fetchMovieDetails(movieId) {
  const url = `${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}&append_to_response=credits,videos`;
  try {
    const { data } = await axios.get(url);
    return data;
  } catch (err) {
    console.error(`[TMDb] Failed to fetch details for movie ${movieId}:`, err.message);
    return null;
  }
}

export async function fetchMoviePage(page) {
  const url = `${TMDB_BASE}/movie/top_rated?api_key=${TMDB_API_KEY}&language=${LANGUAGE}&region=${REGION}&page=${page}`;
  const { data } = await axios.get(url);
  return data.results || [];
}

/**
 * Finds a movie on TMDb by its IMDb ID.
 * @param {string} imdbId - e.g. "tt2106476"
 * @returns {Promise<Object|null>} TMDb basic movie result or null
 */
export async function fetchMovieByImdbId(imdbId) {
  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&language=${LANGUAGE}&external_source=imdb_id`;
  try {
    const { data } = await axios.get(url);
    if (data.movie_results && data.movie_results.length > 0) {
      return data.movie_results[0];
    }
    console.warn(`[TMDb] No movie found for IMDb ID: ${imdbId}`);
    return null;
  } catch (err) {
    console.error(`[TMDb] Failed to find movie for IMDb ID ${imdbId}:`, err.message);
    return null;
  }
}