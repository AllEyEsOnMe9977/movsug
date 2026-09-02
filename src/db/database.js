import mysql from 'mysql2/promise';

// Connection pool — reused across the app instead of opening a new connection per query
let pool;

export function openDB() {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  console.log('[DB] MariaDB pool created.');
  return pool;
}

export async function initDB(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS movies (
       id INT PRIMARY KEY,
       title VARCHAR(255),
       original_title VARCHAR(255),
       overview TEXT,
       release_date DATE,
       poster_path VARCHAR(255),
       backdrop_path VARCHAR(255),
       vote_average DECIMAL(3,1),
       imdb_id VARCHAR(20),
       imdb_rating DECIMAL(3,1),
       imdb_votes INT,
       genres JSON,
       runtime INT,
       sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS last_post_time (
       id INT PRIMARY KEY,
       timestamp DATETIME
     )`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS reviews (
       movie_id INT PRIMARY KEY,
       review TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
     )`
  );
  console.log('[DB] Tables ready.');
}

export async function isMovieSent(db, movieId) {
  const [rows] = await db.query('SELECT 1 FROM movies WHERE id = ?', [movieId]);
  return rows.length > 0;
}

export async function markMovieAsSent(db, movie, details, omdb) {
  await db.query(
    `INSERT INTO movies (
       id, title, original_title, overview, release_date,
       poster_path, backdrop_path, vote_average,
       imdb_id, imdb_rating, imdb_votes, genres, runtime
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movie.id,
      movie.title,
      movie.original_title,
      movie.overview,
      movie.release_date || null,
      movie.poster_path,
      movie.backdrop_path,
      movie.vote_average,
      details.imdb_id || null,
      omdb?.imdbRating ?? null,
      omdb?.imdbVotes ?? null,
      details.genres ? JSON.stringify(details.genres.map((g) => g.name)) : null,
      details.runtime ?? null,
    ]
  );
}

/** Stores (or overwrites) the generated review text for a movie. */
export async function saveMovieReview(db, movieId, reviewText) {
  await db.query(
    `INSERT INTO reviews (movie_id, review) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE review = VALUES(review), created_at = CURRENT_TIMESTAMP`,
    [movieId, reviewText]
  );
}

export async function getMovieReview(db, movieId) {
  const [rows] = await db.query('SELECT review FROM reviews WHERE movie_id = ?', [movieId]);
  return rows.length ? rows[0].review : null;
}