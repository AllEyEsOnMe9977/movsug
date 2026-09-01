import axios from 'axios';
import { OMDB_API_KEY } from '../config/env.js';

export async function fetchOMDbRatings(imdbId) {
  if (!imdbId) {
    console.warn('[OMDb] No IMDb ID provided — skipping OMDb lookup.');
    return { imdbRating: null, imdbVotes: null, rottenTomatoes: null, metacritic: null };
  }

  const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
  try {
    const { data } = await axios.get(url);

    if (data.Response === 'False') {
      console.warn(`[OMDb] No result for IMDb ID ${imdbId}: ${data.Error}`);
      return { imdbRating: null, imdbVotes: null, rottenTomatoes: null, metacritic: null };
    }

    const imdbRating = data.imdbRating && data.imdbRating !== 'N/A'
      ? parseFloat(data.imdbRating) : null;

    const imdbVotes = data.imdbVotes && data.imdbVotes !== 'N/A'
      ? parseInt(data.imdbVotes.replace(/,/g, ''), 10) : null;

    const rtEntry = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    const rottenTomatoes = rtEntry ? rtEntry.Value : null;

    const mcEntry = (data.Ratings || []).find((r) => r.Source === 'Metacritic');
    const metacritic = mcEntry
      ? mcEntry.Value
      : (data.Metascore && data.Metascore !== 'N/A' ? `${data.Metascore}/100` : null);

    console.log(`[OMDb] ${imdbId} → IMDb: ${imdbRating} (${imdbVotes} votes), RT: ${rottenTomatoes}, MC: ${metacritic}`);
    return { imdbRating, imdbVotes, rottenTomatoes, metacritic };
  } catch (err) {
    console.error(`[OMDb] Request failed for ${imdbId}:`, err.message);
    return { imdbRating: null, imdbVotes: null, rottenTomatoes: null, metacritic: null };
  }
}