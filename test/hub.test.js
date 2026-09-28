import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MAX_ROOMS, MAX_ROOMS_PER_IP } from '../server/hub.js';
import { Room } from '../server/room.js';
import { RateLimiter } from '../server/limiter.js';
import { HttpError } from '../server/http.js';

const SLOW = { turnMs: 100000, returnMs: 100000, botMs: 100000, nextHandMs: 100000 };
const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError, String(e)); return e.code; }
  return null;
};

test('rooms are capped per IP and in total', () => {
  const hub = new Hub({ delays: SLOW });
  for (let i = 0; i < MAX_ROOMS_PER_IP; i++) hub.createRoom('甲', null, '10.0.0.1');
  assert.equal(code(() => hub.createRoom('甲', null, '10.0.0.1')), 'too_many_rooms');
  for (let i = hub.rooms.size; i < MAX_ROOMS; i++) hub.createRoom('乙', null, `10.1.${i >> 8}.${i & 255}`);
  assert.equal(code(() => hub.createRoom('丙', null, '10.9.9.9')), 'server_busy');
  for (const c of [...hub.rooms.keys()]) hub.deleteRoom(c);
});

test('idle lobbies are swept after 15 minutes, running rooms after 6 hours', () => {
  let now = 0;
  const hub = new Hub({ delays: SLOW, now: () => now });
  const { room: lobby } = hub.createRoom('甲');
  const { room: busy, player } = hub.createRoom('乙');
  for (let i = 0; i < 3; i++) busy.addBot(player.id);
  busy.start(player.id);
  now += 16 * 60 * 1000;
  hub.sweep();
  assert.equal(hub.rooms.has(lobby.code), false);
  assert.equal(hub.rooms.has(busy.code), true);
  now += 6 * 60 * 60 * 1000;
  hub.sweep();
  assert.equal(hub.rooms.has(busy.code), false);
});

test('send skips streams that already ended', () => {
  const hub = new Hub({ delays: SLOW });
  let writes = 0;
  hub.send({ writableEnded: true, write: () => { writes += 1; } }, {});
  hub.send({ destroyed: true, write: () => { writes += 1; } }, {});
  assert.equal(writes, 0);
});

function startedRoom() {
  const room = new Room({ code: 'LEFT', delays: SLOW });
  const host = room.addHuman('甲');
  const guest = room.addHuman('乙');
  room.addBot(host.id);
  room.addBot(host.id);
  room.setOnline(host.id, true);
  room.setOnline(guest.id, true);
  room.start(host.id);
  return { room, host, guest };
}

test('leaving mid-match is permanent: auto-play, no own actions, host passes on', () => {
  const { room, host, guest } = startedRoom();
  room.markLeft(host.id);
  assert.equal(room.hostId, guest.id);
  assert.equal(room.isAutomatic(0), true);
  assert.equal(code(() => room.pass(host.id)), 'left_match');
  room.setOnline(host.id, true); // reconnecting does not undo it
  assert.equal(room.isAutomatic(0), true);
  assert.equal(room.humanCount(), 1);
  room.destroy();
});

test('leaving after the match keeps seats until the room returns to the lobby', () => {
  const { room, host, guest } = startedRoom();
  room.phase = 'match_over';
  room.removePlayer(host.id, host.id);
  assert.equal(room.players.length, 4, 'seats stay fixed while results are shown');
  assert.equal(room.hostId, guest.id);
  room.restart(guest.id);
  assert.deepEqual(room.players.map((p) => p.name), ['乙', room.players[1].name, room.players[2].name]);
  assert.equal(room.players.length, 3);
  room.destroy();
});

test('a failing automatic action is logged, not thrown', async () => {
  const room = new Room({ code: 'BOOM', delays: SLOW });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    room.setTimer(0, () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test('rate limiter allows the limit per window, then refuses', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) limiter.hit('ip');
  assert.equal(code(() => limiter.hit('ip')), 'too_many_attempts');
  limiter.hit('other');
  now += 1001;
  limiter.hit('ip');
  limiter.prune();
  assert.equal(limiter.hits.size, 1);
});
