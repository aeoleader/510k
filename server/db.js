import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Schema changes are appended here; each entry runs once, in order, tracked by user_version.
const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     salt TEXT NOT NULL,
     rating INTEGER NOT NULL DEFAULT 60,
     card_counter INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE matches (
     id INTEGER PRIMARY KEY,
     room_code TEXT NOT NULL,
     player_count INTEGER NOT NULL,
     decks INTEGER NOT NULL,
     mode TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER NOT NULL,
     final_scores TEXT NOT NULL
   );
   CREATE TABLE match_players (
     match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
     seat INTEGER NOT NULL,
     user_id INTEGER REFERENCES users(id),
     display_name TEXT NOT NULL,
     is_bot INTEGER NOT NULL,
     team INTEGER,
     total_score INTEGER NOT NULL,
     heads INTEGER NOT NULL,
     tails INTEGER NOT NULL,
     rating_before INTEGER,
     rating_delta INTEGER,
     left_early INTEGER NOT NULL,
     PRIMARY KEY (match_id, seat)
   );
   CREATE INDEX match_players_user ON match_players(user_id);`,
];

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
