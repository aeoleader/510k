import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Hub, MAX_ROOMS, MAX_ROOMS_PER_IP } from '../server/hub.js';
import { Room, DEFAULT_DELAYS } from '../server/room.js';
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

test('refreshing one user pushes a view to that player only', () => {
  const hub = new Hub({ delays: SLOW });
  const { room, player } = hub.createRoom('甲', { id: 7 });
  const other = room.addHuman('乙');
  const writes = { mine: 0, theirs: 0 };
  const fake = (key) => ({ write: () => { writes[key] += 1; }, end: () => {} });
  hub.clients.set(room.code, new Map([[player.id, new Set([fake('mine')])], [other.id, new Set([fake('theirs')])]]));
  hub.refreshUser(7);
  assert.deepEqual(writes, { mine: 1, theirs: 0 });
  hub.deleteRoom(room.code);
});

// A 4-seat match in progress: host 甲 (guest), guest 乙, account seat 阿杰, one bot.
function matchInProgress() {
  const clock = { t: 1_000_000 };
  const hub = new Hub({ delays: SLOW, now: () => clock.t });
  const { room, player: host } = hub.createRoom('甲');
  const { player: guest } = hub.joinRoom(room.code, '乙');
  const { player: member } = hub.joinRoom(room.code, '阿杰', { id: 7, username: '阿杰' });
  room.addBot(host.id);
  for (const p of [host, guest, member]) room.setOnline(p.id, true);
  room.start(host.id);
  return { hub, room, host, guest, member, clock };
}

test('a guest who left mid-match takes the seat back by name', () => {
  const { hub, room, guest } = matchInProgress();
  const seat = room.players.indexOf(guest);
  const oldToken = guest.token;
  hub.leave(room, guest);
  assert.equal(guest.leftEarly, true);
  const { player } = hub.joinRoom(room.code, '乙');
  assert.equal(player, guest, 'same seat');
  assert.equal(room.players.indexOf(player), seat);
  assert.notEqual(player.token, oldToken, 'a fresh token');
  assert.equal(code(() => hub.authenticate(room.code, oldToken)), 'bad_token');
  assert.equal(hub.authenticate(room.code, player.token).player, guest);
  assert.equal(player.leftEarly, false, 'rated normally again');
  assert.ok(room.log.some((l) => l.text === '乙 回到了牌桌'));
  hub.deleteRoom(room.code);
});

test('reclaiming by name: online seats and account seats are refused, offline guests come back', () => {
  const { hub, room, guest, clock } = matchInProgress();
  assert.equal(code(() => hub.joinRoom(room.code, '乙')), 'name_in_use', 'the owner is still online');
  assert.equal(code(() => hub.joinRoom(room.code, '阿杰')), 'name_in_use', 'a guest cannot take an account seat');
  assert.equal(code(() => hub.joinRoom(room.code, '丙')), 'in_progress', 'no such seat');
  room.setOnline(guest.id, false); // their stream closed
  assert.equal(room.isAutomatic(room.players.indexOf(guest)), true);
  assert.equal(code(() => hub.joinRoom(room.code, '乙')), 'name_in_use', 'a moment offline is not enough');
  clock.t += DEFAULT_DELAYS.reclaimOfflineMs - 1;
  assert.equal(code(() => hub.joinRoom(room.code, '乙')), 'name_in_use');
  clock.t += 1;
  const oldToken = guest.token;
  assert.equal(hub.joinRoom(room.code, '乙').player, guest);
  assert.notEqual(guest.token, oldToken);
  hub.deleteRoom(room.code);
});

test('a logged-in player who left mid-match gets the seat back and is no longer counted as left', () => {
  const { hub, room, member } = matchInProgress();
  hub.leave(room, member);
  assert.equal(member.leftEarly, true);
  assert.equal(code(() => hub.joinRoom(room.code, '阿杰')), 'name_in_use', 'still only for the account');
  assert.equal(code(() => hub.joinRoom(room.code, '阿杰', { id: 8, username: '阿杰' })), 'in_progress');
  const oldToken = member.token;
  assert.equal(hub.joinRoom(room.code, '阿杰', { id: 7, username: '阿杰' }).player, member);
  assert.equal(member.leftEarly, false);
  assert.notEqual(member.token, oldToken);
  hub.deleteRoom(room.code);
});

test('reclaiming by name with duplicate names takes the seat that can be reclaimed', () => {
  const { hub, room, host, clock } = matchInProgress();
  const twin = room.players.find((p) => p.isBot);
  Object.assign(twin, { isBot: false, name: '乙', token: 'twin-token' }); // a second guest named 乙, offline
  room.offlineSince.set(twin.id, clock.t);
  clock.t += DEFAULT_DELAYS.reclaimOfflineMs;
  assert.equal(room.players.findIndex((p) => p.name === '乙') < room.players.indexOf(twin), true, 'the online 乙 comes first');
  assert.equal(hub.joinRoom(room.code, '乙').player, twin);
  assert.equal(host.leftEarly, false);
  hub.deleteRoom(room.code);
});

test('rejoining with the token of a seat that left mid-match puts the owner back in control', () => {
  const { hub, room, guest } = matchInProgress();
  const token = guest.token;
  hub.leave(room, guest);
  assert.equal(guest.leftEarly, true);
  assert.equal(hub.rejoin(room, room.findByToken(token)), guest);
  assert.equal(guest.leftEarly, false);
  assert.equal(guest.token, token, 'the token the caller holds stays valid');
  assert.match(room.log.at(-1).text, /回到了牌桌/);
  hub.deleteRoom(room.code);
});

test('in the lobby a taken name still just adds another player', () => {
  const hub = new Hub({ delays: SLOW });
  const { room } = hub.createRoom('甲');
  const { player } = hub.joinRoom(room.code, '甲');
  assert.equal(room.players.length, 2);
  assert.notEqual(player, room.players[0]);
  hub.deleteRoom(room.code);
});

test('a room error while a stream opens or closes is logged, not thrown', () => {
  const hub = new Hub({ delays: SLOW });
  const { room, player } = hub.createRoom('甲');
  room.setOnline = () => { throw new Error('boom'); };
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() { this.writableEnded = true; },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    hub.connect(room, player, req, res);
    req.emit('close');
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2, 'both the open and the close were logged');
  assert.equal(hub.streams, 0);
  hub.deleteRoom(room.code);
});
