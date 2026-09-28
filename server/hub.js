import crypto from 'node:crypto';
import { Room, DEFAULT_DELAYS } from './room.js';
import { HttpError } from './http.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEEPALIVE_MS = 20000;
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

// Owns all rooms and their SSE listeners; pushes a per-player view after every change.
export class Hub {
  constructor({ delays = DEFAULT_DELAYS, timers = globalThis, now = Date.now } = {}) {
    this.delays = delays;
    this.timers = timers;
    this.now = now;
    this.rooms = new Map();
    this.clients = new Map(); // code -> Map(playerId -> Set(res))
  }

  createRoom(name) {
    let code;
    do code = randomCode(); while (this.rooms.has(code));
    const room = new Room({ code, delays: this.delays, timers: this.timers, now: this.now, onChange: (r) => this.broadcast(r) });
    this.rooms.set(code, room);
    const player = room.addHuman(name);
    return { room, player };
  }

  getRoom(code) {
    const room = this.rooms.get(code);
    if (!room) throw new HttpError(404, 'no_room');
    return room;
  }

  joinRoom(code, name) {
    const room = this.getRoom(code);
    return { room, player: room.addHuman(name) };
  }

  authenticate(code, token) {
    const room = this.getRoom(code);
    const player = room.findByToken(token);
    if (!player) throw new HttpError(401, 'bad_token');
    return { room, player };
  }

  leave(room, player) {
    if (room.phase === 'lobby') room.removePlayer(player.id, player.id);
    for (const res of this.clients.get(room.code)?.get(player.id) ?? []) res.end();
    if (room.humanCount() === 0) this.deleteRoom(room.code);
  }

  deleteRoom(code) {
    this.rooms.get(code)?.destroy();
    this.rooms.delete(code);
    for (const set of this.clients.get(code)?.values() ?? []) for (const res of set) res.end();
    this.clients.delete(code);
  }

  connect(room, player, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (!this.clients.has(room.code)) this.clients.set(room.code, new Map());
    const byPlayer = this.clients.get(room.code);
    if (!byPlayer.has(player.id)) byPlayer.set(player.id, new Set());
    byPlayer.get(player.id).add(res);
    this.send(res, room.viewFor(player.id));
    room.setOnline(player.id, true);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    const close = () => {
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
  }

  send(res, view) {
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
    const cutoff = this.now() - ROOM_TTL_MS;
    for (const [code, room] of this.rooms) {
      const listeners = this.clients.get(code)?.size ?? 0;
      if (listeners === 0 && room.updatedAt < cutoff) this.deleteRoom(code);
    }
  }
}
