import crypto from 'node:crypto';
import { transaction } from './db.js';
import { HttpError } from './http.js';
import { START_RATING, rankInfo } from '../engine/rating.js';

const MAX_USERNAME_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 64;
const KEY_LENGTH = 32;

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');

export function parseUsername(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > MAX_USERNAME_LENGTH || /\s/.test(name)) throw new HttpError(400, 'bad_username');
  return name;
}

export function parsePassword(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, 'bad_password');
  }
  return value;
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
      byToken: db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?'),
      addSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
      dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      setRating: db.prepare('UPDATE users SET rating = ? WHERE id = ?'),
      insertMatch: db.prepare(`INSERT INTO matches (room_code, player_count, decks, mode, started_at, ended_at, final_scores)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`),
      insertMatchPlayer: db.prepare(`INSERT INTO match_players (match_id, seat, user_id, display_name, is_bot, team, total_score,
                                     heads, tails, rating_before, rating_delta, left_early) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  createUser(username, password, rating = START_RATING) {
    if (this.q.byName.get(username)) throw new HttpError(409, 'username_taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastInsertRowid } = this.q.insert.run(username, hashPassword(password, salt), salt, rating, this.now());
    return this.q.byId.get(Number(lastInsertRowid));
  }

  register(username, password) {
    const user = this.createUser(parseUsername(username), parsePassword(password));
    return { token: this.openSession(user), user };
  }

  login(username, password) {
    const user = this.q.byName.get(String(username ?? '').trim());
    const given = typeof password === 'string' ? password : '';
    const ok = user && crypto.timingSafeEqual(Buffer.from(hashPassword(given, user.salt), 'hex'), Buffer.from(user.password_hash, 'hex'));
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
    const user = typeof token === 'string' ? this.q.byToken.get(token) : null;
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
        if (p.userId && Number.isInteger(p.delta)) this.q.setRating.run(p.ratingBefore + p.delta, p.userId);
      }
      return matchId;
    });
  }

  // One-off import of card-game's accounts.json ({ users: { key: { username, password } } }).
  // Ratings are separate per game, so imported players start at START_RATING.
  importCardGame(data) {
    const summary = { imported: 0, skipped: [] };
    const users = Object.values(data?.users ?? {});
    transaction(this.db, () => {
      for (const u of users) {
        let username;
        try {
          username = parseUsername(u.username);
          parsePassword(u.password);
        } catch {
          summary.skipped.push({ username: String(u.username ?? ''), reason: 'invalid' });
          continue;
        }
        if (this.q.byName.get(username)) {
          summary.skipped.push({ username, reason: 'exists' });
          continue;
        }
        this.createUser(username, u.password);
        summary.imported += 1;
      }
    });
    return summary;
  }
}
