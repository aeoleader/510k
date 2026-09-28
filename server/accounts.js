import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { transaction } from './db.js';
import { HttpError } from './http.js';
import { cleanText } from './validate.js';
import { START_RATING, rankInfo } from '../engine/rating.js';

const MAX_USERNAME_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 64;
export const MIN_NEW_PASSWORD_LENGTH = 6;
const KEY_LENGTH = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const scrypt = promisify(crypto.scrypt);
// Async so hashing never blocks the event loop that runs every game.
const hashPassword = async (password, salt) => (await scrypt(password, salt, KEY_LENGTH)).toString('hex');
// Unknown usernames still pay for one hash, so response time does not reveal which names exist.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

export function parseUsername(value) {
  const name = cleanText(value);
  if (!name || [...name].length > MAX_USERNAME_LENGTH || /\s/.test(name)) throw new HttpError(400, 'bad_username');
  return name;
}

export function parsePassword(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, 'bad_password');
  }
  return value;
}

export function parseNewPassword(value) {
  const password = parsePassword(value);
  if (password.length < MIN_NEW_PASSWORD_LENGTH) throw new HttpError(400, 'short_password');
  return password;
}

// What other players and the owner see: never the hash, salt or id of the session.
export function publicAccount(user) {
  if (!user) return null;
  const info = rankInfo(user.rating);
  return {
    username: user.username,
    rating: user.rating,
    tier: info.index,
    tierName: info.name,
    stars: info.stars,
    maxStars: info.index === 6 ? null : 3,
  };
}

export class Accounts {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    this.q = {
      insert: db.prepare('INSERT INTO users (username, password_hash, salt, rating, created_at) VALUES (?, ?, ?, ?, ?)'),
      byName: db.prepare('SELECT * FROM users WHERE username = ?'),
      byId: db.prepare('SELECT * FROM users WHERE id = ?'),
      byToken: db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.created_at > ?'),
      addSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
      dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      addRating: db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?'),
      insertMatch: db.prepare(`INSERT INTO matches (room_code, player_count, decks, mode, started_at, ended_at, final_scores)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`),
      insertMatchPlayer: db.prepare(`INSERT INTO match_players (match_id, seat, user_id, display_name, is_bot, team, total_score,
                                     heads, tails, rating_before, rating_delta, left_early) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  // `hash`/`salt` are computed beforehand (async) so the insert itself stays synchronous.
  insertUser(username, hash, salt, rating = START_RATING) {
    if (this.q.byName.get(username)) throw new HttpError(409, 'username_taken');
    const { lastInsertRowid } = this.q.insert.run(username, hash, salt, rating, this.now());
    return this.q.byId.get(Number(lastInsertRowid));
  }

  async register(username, password) {
    const name = parseUsername(username);
    const pw = parseNewPassword(password);
    if (this.q.byName.get(name)) throw new HttpError(409, 'username_taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = this.insertUser(name, await hashPassword(pw, salt), salt);
    return { token: this.openSession(user), user };
  }

  async login(username, password) {
    const user = this.q.byName.get(cleanText(username));
    const given = typeof password === 'string' ? password.slice(0, MAX_PASSWORD_LENGTH) : '';
    const hash = await hashPassword(given, user ? user.salt : DUMMY_SALT);
    const ok = user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
    if (!ok) throw new HttpError(401, 'bad_login');
    return { token: this.openSession(user), user };
  }

  openSession(user) {
    const token = crypto.randomBytes(24).toString('hex');
    this.q.addSession.run(token, user.id, this.now());
    return token;
  }

  // null when no token was given; throws when a token was given but is unknown.
  userForToken(token) {
    if (token === undefined || token === null || token === '') return null;
    const user = typeof token === 'string' ? this.q.byToken.get(token, this.now() - SESSION_TTL_MS) : null;
    if (!user) throw new HttpError(401, 'session_expired');
    return user;
  }

  logout(token) {
    if (typeof token === 'string') this.q.dropSession.run(token);
  }

  getUser(id) {
    return this.q.byId.get(id) ?? null;
  }

  // Persist one finished match and every rated player's new rating, atomically.
  recordMatch({ roomCode, playerCount, decks, mode, startedAt, endedAt, totals, players }) {
    return transaction(this.db, () => {
      const { lastInsertRowid } = this.q.insertMatch.run(roomCode, playerCount, decks, mode, startedAt, endedAt, JSON.stringify(totals));
      const matchId = Number(lastInsertRowid);
      for (const p of players) {
        this.q.insertMatchPlayer.run(matchId, p.seat, p.userId ?? null, p.name, p.isBot ? 1 : 0, p.team ?? null,
          p.total, p.heads, p.tails, p.ratingBefore ?? null, p.delta ?? null, p.leftEarly ? 1 : 0);
        // Add the delta to the stored rating (not before + delta), so overlapping matches cannot overwrite each other.
        if (p.userId && Number.isInteger(p.delta)) this.q.addRating.run(p.delta, p.userId);
      }
      return matchId;
    });
  }

  // One-off import of card-game's accounts.json ({ users: { key: { username, password } } }).
  // Ratings are separate per game, so imported players start at START_RATING.
  // Existing card-game passwords are kept as they are, even if shorter than the new-password minimum.
  async importCardGame(data) {
    const summary = { imported: 0, skipped: [] };
    const rows = [];
    const seen = new Set();
    for (const u of Object.values(data?.users ?? {})) {
      let username;
      try {
        username = parseUsername(u.username);
        parsePassword(u.password);
      } catch {
        summary.skipped.push({ username: String(u.username ?? ''), reason: 'invalid' });
        continue;
      }
      if (this.q.byName.get(username) || seen.has(username.toLowerCase())) {
        summary.skipped.push({ username, reason: 'exists' });
        continue;
      }
      seen.add(username.toLowerCase());
      const salt = crypto.randomBytes(16).toString('hex');
      rows.push({ username, salt, hash: await hashPassword(u.password, salt) });
    }
    transaction(this.db, () => {
      for (const r of rows) this.insertUser(r.username, r.hash, r.salt);
    });
    summary.imported = rows.length;
    return summary;
  }
}
