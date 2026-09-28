import crypto from 'node:crypto';
import { Room, DEFAULT_DELAYS } from './room.js';
import { HttpError } from './http.js';
import { publicAccount } from './accounts.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEEPALIVE_MS = 20000;
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
export const IDLE_LOBBY_TTL_MS = 15 * 60 * 1000;
export const MAX_ROOMS = 200;
export const MAX_ROOMS_PER_IP = 5;
export const MAX_STREAMS_PER_PLAYER = 3;
export const MAX_STREAMS = 2000;

function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

// Owns all rooms and their SSE listeners; pushes a per-player view after every change.
export class Hub {
  constructor({ delays = DEFAULT_DELAYS, timers = globalThis, now = Date.now, accounts = null } = {}) {
    this.accounts = accounts;
    this.delays = delays;
    this.timers = timers;
    this.now = now;
    this.rooms = new Map();
    this.clients = new Map(); // code -> Map(playerId -> Set(res))
    this.streams = 0;
    this.accountCache = new Map(); // userId -> public account; ratings only change in recordMatch
    this.counterCache = new Map(); // userId -> card counter enabled
  }

  counterFor(userId) {
    if (!this.accounts) return false;
    if (!this.counterCache.has(userId)) this.counterCache.set(userId, Boolean(this.accounts.getUser(userId)?.card_counter));
    return this.counterCache.get(userId);
  }

  // After an admin change: drop cached account data and push a fresh view to that player only,
  // so nobody else at the table can notice that anything changed.
  refreshUser(userId) {
    this.accountCache.delete(userId);
    this.counterCache.delete(userId);
    for (const room of this.rooms.values()) {
      const player = room.findByUser(userId);
      if (!player) continue;
      const view = room.viewFor(player.id);
      for (const res of this.clients.get(room.code)?.get(player.id) ?? []) this.send(res, view);
    }
  }

  accountView(userId) {
    if (!this.accounts) return null;
    if (!this.accountCache.has(userId)) this.accountCache.set(userId, publicAccount(this.accounts.getUser(userId)));
    return this.accountCache.get(userId);
  }

  createRoom(name, user = null, ip = null) {
    if (this.rooms.size >= MAX_ROOMS) throw new HttpError(503, 'server_busy');
    if (ip && [...this.rooms.values()].filter((r) => r.creatorIp === ip).length >= MAX_ROOMS_PER_IP) {
      throw new HttpError(429, 'too_many_rooms');
    }
    let code;
    do code = randomCode(); while (this.rooms.has(code));
    const room = new Room({
      code,
      delays: this.delays,
      timers: this.timers,
      now: this.now,
      onChange: (r) => this.broadcast(r),
      accountView: (userId) => this.accountView(userId),
      onMatchOver: (r) => this.recordMatch(r),
      counterFor: (userId) => this.counterFor(userId),
    });
    room.creatorIp = ip;
    this.rooms.set(code, room);
    const player = room.addHuman(name, user);
    return { room, player };
  }

  recordMatch(room) {
    if (!this.accounts) return;
    for (const p of room.players) if (p.userId) this.accountCache.delete(p.userId);
    const { match } = room;
    room.matchId = this.accounts.recordMatch({
      roomCode: room.code,
      playerCount: match.playerCount,
      decks: match.decks,
      mode: match.teams ? 'team' : 'ffa',
      startedAt: room.startedAt,
      endedAt: this.now(),
      totals: match.totals,
      players: room.players.map((p, seat) => ({
        seat,
        userId: p.userId,
        name: p.name,
        isBot: p.isBot,
        team: match.teams ? match.teams[seat] : null,
        total: match.totals[match.teams ? match.teams[seat] : seat],
        heads: match.heads[seat],
        tails: match.tails[seat],
        ratingBefore: room.ratingResult[seat].before,
        delta: room.ratingResult[seat].delta,
        leftEarly: p.leftEarly,
      })),
      hands: room.handLog,
    });
  }

  getRoom(code) {
    const room = this.rooms.get(code);
    if (!room) throw new HttpError(404, 'no_room');
    return room;
  }

  // A logged-in player who already holds a seat in this room gets that seat back.
  // Mid-match, a guest may take back a guest seat of the same name while it is on auto-play.
  joinRoom(code, name, user = null) {
    const room = this.getRoom(code);
    const existing = user ? room.findByUser(user.id) : null;
    if (existing) {
      if (existing.leftEarly && room.inMatch()) this.reclaim(room, existing);
      return { room, player: existing };
    }
    const seat = !user && room.inMatch() ? room.players.find((p) => !p.isBot && !p.gone && p.name === name) : null;
    if (seat) {
      const automatic = seat.leftEarly || !room.online.has(seat.id);
      if (seat.userId !== null || !automatic) throw new HttpError(409, 'name_in_use');
      this.reclaim(room, seat);
      return { room, player: seat };
    }
    return { room, player: room.addHuman(name, user) };
  }

  reclaim(room, player) {
    this.closeStreams(room, player.id);
    room.reclaim(player.id);
  }

  authenticate(code, token) {
    const room = this.getRoom(code);
    const player = room.findByToken(token);
    if (!player) throw new HttpError(401, 'bad_token');
    return { room, player };
  }

  leave(room, player) {
    if (room.phase === 'lobby' || room.phase === 'match_over') room.removePlayer(player.id, player.id);
    else room.markLeft(player.id);
    this.closeStreams(room, player.id);
    if (room.humanCount() === 0) this.deleteRoom(room.code);
  }

  kick(room, byId, playerId) {
    room.removePlayer(byId, playerId);
    this.closeStreams(room, playerId);
  }

  closeStreams(room, playerId) {
    for (const res of [...(this.clients.get(room.code)?.get(playerId) ?? [])]) res.end();
  }

  deleteRoom(code) {
    this.rooms.get(code)?.destroy();
    this.rooms.delete(code);
    for (const set of this.clients.get(code)?.values() ?? []) for (const res of set) res.end();
    this.clients.delete(code);
  }

  connect(room, player, req, res) {
    if (this.streams >= MAX_STREAMS) throw new HttpError(503, 'server_busy');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (!this.clients.has(room.code)) this.clients.set(room.code, new Map());
    const byPlayer = this.clients.get(room.code);
    if (!byPlayer.has(player.id)) byPlayer.set(player.id, new Set());
    const mine = byPlayer.get(player.id);
    // A few tabs per player are fine; beyond that the oldest stream is closed.
    while (mine.size >= MAX_STREAMS_PER_PLAYER) {
      const oldest = mine.values().next().value;
      mine.delete(oldest);
      oldest.end();
    }
    mine.add(res);
    this.streams += 1;
    this.send(res, room.viewFor(player.id));
    room.setOnline(player.id, true);
    const keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.streams -= 1;
      clearInterval(keepalive);
      const set = byPlayer.get(player.id);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) {
        byPlayer.delete(player.id);
        if (this.rooms.get(room.code) === room) room.setOnline(player.id, false);
      }
    };
    req.on('close', close);
    res.on('close', close);
    res.on('error', close);
  }

  send(res, view) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(view)}\n\n`);
    } catch {
      res.end();
    }
  }

  broadcast(room) {
    for (const [playerId, set] of this.clients.get(room.code) ?? []) {
      const view = room.viewFor(playerId);
      for (const res of set) this.send(res, view);
    }
  }

  sweep() {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      const listeners = this.clients.get(code)?.size ?? 0;
      if (listeners > 0) continue;
      const ttl = room.phase === 'lobby' ? IDLE_LOBBY_TTL_MS : ROOM_TTL_MS;
      if (room.updatedAt < now - ttl) this.deleteRoom(code);
    }
  }
}
