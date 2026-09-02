import dotenv from 'dotenv';
dotenv.config();

import sqlite3 from 'sqlite3';
import mysql from 'mysql2/promise';

// Two source files: OLD = long-running history (root), NEW = post-reviews-feature (src/db)
const OLD_DB_PATH = '/root/MovRecomm/movies.db';
const NEW_DB_PATH = '/root/MovRecomm/src/db/movies.db';

function getAll(dbPath, query) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
    });
    db.all(query, [], (err, rows) => {
      db.close();
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function migrate() {
  const mariaConn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await mariaConn.query(`CREATE TABLE IF NOT EXISTS movies (id INT PRIMARY KEY)`);
  await mariaConn.query(`CREATE TABLE IF NOT EXISTS last_post_time (id INT PRIMARY KEY, timestamp DATETIME)`);
  await mariaConn.query(`CREATE TABLE IF NOT EXISTS reviews (movie_id INT PRIMARY KEY, review TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // ── Movies: union of OLD (authoritative history) + NEW (post-reviews additions) ──
  const oldMovies = await getAll(OLD_DB_PATH, 'SELECT id FROM movies');
  const newMovies = await getAll(NEW_DB_PATH, 'SELECT id FROM movies');

  const allMovieIds = new Set([
    ...oldMovies.map((r) => r.id),
    ...newMovies.map((r) => r.id),
  ]);

  for (const id of allMovieIds) {
    await mariaConn.query('INSERT IGNORE INTO movies (id) VALUES (?)', [id]);
  }
  console.log(`[Migrate] Copied ${allMovieIds.size} unique rows into movies (old: ${oldMovies.length}, new: ${newMovies.length}).`);

  // ── Reviews: only exist in NEW file ──
  const reviews = await getAll(NEW_DB_PATH, 'SELECT movie_id, review, created_at FROM reviews');
  for (const row of reviews) {
    await mariaConn.query(
      'INSERT IGNORE INTO reviews (movie_id, review, created_at) VALUES (?, ?, ?)',
      [row.movie_id, row.review, row.created_at]
    );
  }
  console.log(`[Migrate] Copied ${reviews.length} rows into reviews.`);

  // ── last_post_time: only exists in OLD file ──
  const lastPost = await getAll(OLD_DB_PATH, 'SELECT id, timestamp FROM last_post_time');
  for (const row of lastPost) {
    await mariaConn.query('INSERT IGNORE INTO last_post_time (id, timestamp) VALUES (?, ?)', [row.id, row.timestamp]);
  }
  console.log(`[Migrate] Copied ${lastPost.length} rows into last_post_time.`);

  await mariaConn.end();
  console.log('[Migrate] Done.');
}

migrate().catch((err) => {
  console.error('[Migrate] Failed:', err);
  process.exit(1);
});