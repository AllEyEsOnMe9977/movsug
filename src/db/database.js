import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function openDB() {
  // DB will be created inside the src/db/ folder
  return new sqlite3.Database(path.join(__dirname, 'movies.db'), (err) => {
    if (err) console.error('[DB] Failed to open database:', err.message);
    else console.log('[DB] Database opened.');
  });
}

export function initDB(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS movies (id INTEGER PRIMARY KEY)`,
        (err) => { if (err) return reject(err); }
      );
      db.run(
        `CREATE TABLE IF NOT EXISTS last_post_time (
           id INTEGER PRIMARY KEY,
           timestamp DATETIME
         )`,
        (err) => {
          if (err) return reject(err);
          console.log('[DB] Tables ready.');
          resolve();
        }
      );
    });
  });
}

export function isMovieSent(db, movieId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM movies WHERE id = ?', [movieId], (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

export function markMovieAsSent(db, movieId) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO movies (id) VALUES (?)', [movieId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}