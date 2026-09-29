import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Room } from '../server/room.js';
import { Hub, SNAPSHOT_MAX_AGE_MS } from '../server/hub.js';
import { openDatabase } from '../server/db.js';
import { Accounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';
import { createHandState } from '../engine/game.js';
import { recordHand } from '../engine/match.js';

// Saving live rooms on shutdown and restoring them on the next start, on a fake clock.

const DELAYS = {
  turnMs: 10000, returnMs: 30000, botMs: 700, nextHandMs: 30000,
  tributeMs: 5000, returnRevealMs: 3000, dealRoundMs: 100, claimGraceMs: 3000, restoreGraceMs: 20000,
};
const GRACE = DELAYS.restoreGraceMs;

// Fake timers and clock: advance(ms) runs every timer due by then, in order.
function fakeClock(start = 1000) {
  let t = start;
  let id = 0;
  const pending = new Map();
  const timers = {
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => pending.delete(h),
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  return { timers, now: () => t, advance, pending };
}

function setup({ humans = ['甲', '乙', '丙', '丁'], online = humans, bots = 0, dealMode = false, random = () => 0 } = {}) {
  const clock = fakeClock();
  const room = new Room({ code: 'SAVE', delays: DELAYS, timers: clock.timers, now: clock.now, random });
  const people = humans.map((n) => room.addHuman(n));
  for (let i = 0; i < bots; i++) room.addBot(people[0].id);
  for (const p of people) if (online.includes(p.name)) room.setOnline(p.id, true);
  if (dealMode) room.setDealMode(people[0].id, true);
  return { room, clock, people, host: people[0] };
}

// What a restart does: the snapshot goes through JSON (the database) and comes back on another clock,
// which here is far ahead of the old one (a clock difference must not matter).
function restart(room, { destroy = true, random = () => 0 } = {}) {
  const data = JSON.parse(JSON.stringify(room.toSnapshot()));
  if (destroy) room.destroy();
  const clock = fakeClock(5_000_000);
  const restored = Room.fromSnapshot(data, { delays: DELAYS, timers: clock.timers, now: clock.now, random });
  return { room: restored, clock, data };
}

const runUntil = (clock, predicate, step = 100, limit = 2_000_000) => {
  for (let spent = 0; !predicate(); spent += step) {
    if (spent > limit) throw new Error('never happened');
    clock.advance(step);
  }
};

const summary = (room) => room.handLog.map((h) => ({
  actions: h.actions.map(({ seat, type, cards }) => ({ seat, type, cards })),
  result: h.result,
}));

// Jump to a second hand with tribute (seat 3 gives to 0, seat 1 to 2), as if hand 1 ended that way.
function tributeHand(room) {
  room.match = recordHand(room.match, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0] }).match;
  do room.startHand(); while (room.prepared?.tribute.resisted); // skip the rare 抗贡 deal (dealing mode deals later)
}

// End the current hand at once: seat 2 is already out, seat 0 plays its last card.
function endHand(room, seat0) {
  room.hand = { ...createHandState({ hands: [['3S0'], ['4S0'], [], ['5S0', '6S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 }), finished: [2] };
  room.play(seat0.id, ['3S0']);
}

test('mid-play: the snapshot is plain JSON and the restored room plays on exactly like the original', () => {
  const { room, clock, host } = setup({ humans: ['甲'], online: [], bots: 3 });
  room.start(host.id);
  runUntil(clock, () => room.actions.length >= 8 && room.hand.turn !== 0);
  const { room: copy, clock: copyClock, data } = restart(room, { destroy: false });
  assert.equal(JSON.stringify(data), JSON.stringify(JSON.parse(JSON.stringify(data))), 'round-trips through JSON');
  for (const key of ['players', 'hostId', 'match', 'prepared', 'hand', 'actions', 'events', 'playedCards', 'seatActions',
    'lastTrick', 'log', 'handLog', 'ratingsBefore', 'startedAt', 'phase', 'turnSeconds', 'decks', 'dealMode']) {
    assert.deepEqual(copy[key], room[key], key);
  }
  assert.equal(copy.version, room.version + 1, 'the version keeps counting up, so clients accept the next view');
  assert.equal(copy.handRecord.lastAt - copyClock.now(), room.handRecord.lastAt - clock.now());
  assert.equal(copy.findByToken(host.token)?.id, host.id, 'tokens still authenticate');
  // The original goes on with the offline human played automatically; the copy waits out the grace first.
  runUntil(clock, () => room.phase === 'hand_over');
  runUntil(copyClock, () => copy.phase === 'hand_over');
  assert.deepEqual(summary(copy), summary(room));
  assert.deepEqual(copy.match, room.match);
  room.destroy();
  copy.destroy();
});

test('grace: an offline human is not auto-played right after a restore, and is once it expires', () => {
  const { room, clock, people } = setup({ humans: ['甲'], bots: 3 });
  room.start(people[0].id);
  runUntil(clock, () => room.hand.turn === 0, 50);
  clock.advance(4000); // 6 s left on the turn clock
  const left = room.deadline - clock.now();
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.online.size, 0);
  assert.equal(copy.hand.turn, 0);
  assert.equal(copy.reclaimable(copy.players[0]), false, 'offline times restart at the restore: nobody takes the seat by name yet');
  assert.equal(copy.deadline, c.now() + left + GRACE, 'what was left of the turn, plus the grace');
  const played = copy.actions.length;
  c.advance(GRACE - 1);
  assert.equal(copy.actions.length, played, 'nobody plays for the offline human during the grace');
  assert.equal(copy.hand.turn, 0);
  c.advance(1);
  assert.equal(copy.graceUntil, null);
  assert.equal(copy.deadline, null, 'offline after the grace: played like any offline seat');
  c.advance(DELAYS.botMs);
  assert.equal(copy.actions.length, played + 1);
  assert.equal(copy.handRecord.actions.at(-1).auto, true);
  copy.destroy();
});

test('grace: a human who reconnects in time gets their turn clock, not auto-play', () => {
  const { room, clock, people } = setup({ humans: ['甲'], bots: 3 });
  room.start(people[0].id);
  runUntil(clock, () => room.hand.turn === 0, 50);
  const { room: copy, clock: c } = restart(room);
  const played = copy.actions.length;
  c.advance(5000);
  copy.setOnline(people[0].id, true);
  assert.equal(copy.deadline, c.now() + DELAYS.turnMs);
  c.advance(DELAYS.turnMs - 1);
  assert.equal(copy.actions.length, played, 'the end of the grace changes nothing for an online player');
  c.advance(1);
  assert.equal(copy.actions.length, played + 1, 'the usual timeout');
  copy.destroy();
});

test('grace with 不计时: an offline human waits out the grace, then is played automatically', () => {
  const { room, clock, people } = setup({ humans: ['甲'], bots: 3 });
  room.setTurnSeconds(people[0].id, 0);
  room.start(people[0].id);
  runUntil(clock, () => room.hand.turn === 0, 50);
  const { room: copy, clock: c } = restart(room);
  const played = copy.actions.length;
  assert.equal(copy.deadline, null);
  c.advance(GRACE + DELAYS.botMs - 1);
  assert.equal(copy.actions.length, played);
  c.advance(1);
  assert.equal(copy.actions.length, played + 1);
  copy.destroy();
});

test('grace: a turn that comes up during the grace is not timed out before the grace ends', () => {
  const { room, clock, people } = setup({ humans: ['甲'], bots: 3 });
  room.start(people[0].id);
  runUntil(clock, () => room.hand.turn === 3, 50); // a bot is about to play; seat 0 is next
  const { room: copy, clock: c } = restart(room);
  runUntil(c, () => copy.hand.turn !== 3, 50);
  if (copy.hand.turn !== 0) return copy.destroy(); // seat 0 already finished this hand
  assert.equal(copy.deadline, copy.graceUntil + DELAYS.turnMs);
  const played = copy.actions.length;
  c.advance(copy.graceUntil - c.now() + DELAYS.botMs);
  assert.equal(copy.actions.length, played + 1);
  assert.equal(copy.handRecord.actions.at(-1).auto, true, 'played by the bot logic once the grace is over');
  copy.destroy();
});

test('dealing without a claim: revealed rounds and bot claim times carry over', () => {
  const { room, clock, host } = setup({ humans: ['甲'], bots: 3, dealMode: true });
  room.start(host.id);
  clock.advance(550);
  const { room: copy, clock: c } = restart(room, { destroy: false });
  assert.equal(copy.phase, 'dealing');
  assert.equal(copy.dealRounds(), 5);
  assert.deepEqual(copy.viewFor(host.id).you.hand, room.viewFor(host.id).you.hand);
  for (const seat of Object.keys(room.dealing.claimAt)) {
    assert.equal(copy.dealing.claimAt[seat] - c.now(), room.dealing.claimAt[seat] - clock.now() + GRACE, 'bot claims wait out the grace too');
  }
  runUntil(clock, () => room.phase !== 'dealing', 50);
  runUntil(c, () => copy.phase !== 'dealing', 50);
  assert.equal(copy.claimedBy, room.claimedBy);
  assert.equal(copy.prepared.leader, room.prepared.leader);
  room.destroy();
  copy.destroy();
});

test('dealing: the deal holds during the grace so reconnecting humans see their cards and can claim', () => {
  const { room, clock, host } = setup({ humans: ['甲'], bots: 3, dealMode: true });
  room.start(host.id);
  clock.advance(550);
  const { room: copy, clock: c } = restart(room);
  const version = copy.version;
  c.advance(GRACE - 1);
  assert.equal(copy.dealRounds(), 5, 'nothing more is dealt during the grace');
  assert.equal(copy.claimedBy, null, 'no bot claims during the grace');
  assert.equal(copy.version, version);
  copy.setOnline(host.id, true);
  assert.deepEqual(copy.viewFor(host.id).you.hand, room.viewFor(host.id).you.hand);
  c.advance(1 + DELAYS.dealRoundMs);
  assert.equal(copy.dealRounds(), 6, 'dealing carries on after the grace');
  // A snapshot taken during the hold keeps the frozen count.
  const { room: again } = restart(copy);
  assert.equal(again.dealRounds(), 6);
  again.destroy();
  room.destroy();
});

test('dealing: the claim grace after the deal is shifted by the restore grace', () => {
  const { room, clock, host } = setup({ humans: ['甲', '乙', '丙', '丁'], dealMode: true });
  room.start(host.id);
  clock.advance(room.dealing.total * DELAYS.dealRoundMs);
  assert.equal(room.dealing.ended, true);
  const left = room.deadline - clock.now();
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.deadline, c.now() + left + GRACE);
  c.advance(GRACE + left - 1);
  assert.equal(copy.phase, 'dealing', 'humans can still show the black 3');
  const holder = copy.dealing.order.findIndex((cards) => cards.some((id) => id.startsWith('3S')));
  if (holder >= 0) {
    copy.claimThree(copy.players[holder].id);
    assert.equal(copy.prepared.leader, holder);
  }
  copy.destroy();
});

test('dealing with a claim: the claim stands and the deal finishes with that leader', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  const [holder, at] = room.dealing.order.map((cards, seat) => [seat, cards.findIndex((c) => c.startsWith('3S'))])
    .filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1])[0] ?? [-1, -1];
  if (at < 0 || at + 1 >= room.dealing.total) return room.destroy(); // no black 3 dealt early enough to claim mid-deal
  clock.advance((at + 1) * DELAYS.dealRoundMs);
  room.claimThree(people[holder].id);
  const rounds = room.dealRounds();
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.claimedBy, holder);
  assert.equal(copy.dealRounds(), rounds);
  runUntil(c, () => copy.phase !== 'dealing', 50);
  assert.equal(copy.prepared.leader, holder);
  copy.destroy();
});

test('returning: pending returns wait out the grace, then are made automatically', () => {
  const { room, clock, host } = setup();
  room.start(host.id);
  tributeHand(room);
  clock.advance(DELAYS.tributeMs);
  assert.equal(room.phase, 'returning');
  const first = room.returns[0];
  room.submitReturn(room.players[first.from].id, room.prepared.hands[first.from][0]);
  clock.advance(1000);
  const left = room.deadline - clock.now();
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.phase, 'returning');
  assert.deepEqual(copy.returns, room.returns);
  assert.equal(copy.deadline, c.now() + left + GRACE);
  c.advance(GRACE - 1);
  assert.equal(copy.phase, 'returning');
  c.advance(1 + DELAYS.botMs);
  assert.equal(copy.phase, 'return_reveal');
  c.advance(DELAYS.returnRevealMs);
  assert.equal(copy.phase, 'playing');
  copy.destroy();
});

test('paused: stays paused with the same time left; resume carries on', () => {
  const { room, clock, host, people } = setup({ humans: ['甲', '乙'], bots: 2 });
  room.start(host.id);
  runUntil(clock, () => !room.players[room.hand.turn].isBot, 50);
  clock.advance(3000);
  room.pause(host.id);
  const remaining = room.pausedRemaining;
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.paused, true);
  assert.equal(copy.pausedRemaining, remaining);
  const version = copy.version;
  c.advance(10 * GRACE);
  assert.equal(copy.version, version, 'nothing moves while paused, not even the end of the grace');
  copy.setOnline(host.id, true);
  copy.setOnline(people[1].id, true);
  copy.resume(host.id);
  assert.equal(copy.deadline, c.now() + remaining);
  copy.destroy();
});

test('paused while dealing: the deal clock stays frozen across the restart', () => {
  const { room, clock, host } = setup({ humans: ['甲'], bots: 3, dealMode: true });
  room.start(host.id);
  clock.advance(750);
  room.pause(host.id);
  clock.advance(5000);
  const { room: copy, clock: c } = restart(room);
  assert.equal(copy.dealRounds(), 7);
  c.advance(60_000);
  assert.equal(copy.dealRounds(), 7);
  copy.setOnline(host.id, true);
  copy.resume(host.id);
  c.advance(300);
  assert.equal(copy.dealRounds(), 10);
  copy.destroy();
});

test('hand_over: the ready set survives; everyone counts as present during the grace', () => {
  const { room, clock, people } = setup({ humans: ['甲', '乙'], bots: 2 });
  room.start(people[0].id);
  endHand(room, people[0]);
  assert.equal(room.phase, 'hand_over');
  room.markReady(people[0].id);
  const { room: copy, clock: c } = restart(room);
  assert.deepEqual([...copy.ready], [0]);
  assert.deepEqual(copy.result, room.result);
  copy.setOnline(people[0].id, true);
  assert.equal(copy.phase, 'hand_over', '乙 may still come back and is not ready yet');
  assert.deepEqual(copy.viewFor(people[0].id).readyWaiting, { ready: 1, needed: 2 }, 'the offline 乙 still counts during the grace');
  c.advance(GRACE);
  assert.notEqual(copy.phase, 'hand_over', 'after the grace only 甲 counts, and 甲 is ready');
  assert.equal(copy.match.handNo, 1);
  copy.destroy();
});

test('lobby: settings and seats come back and the match can start', () => {
  const { room, host, people } = setup({ humans: ['甲', '乙'], bots: 1 });
  room.setDecks(host.id, 3);
  room.setTurnSeconds(host.id, 20);
  room.creatorIp = '10.0.0.1';
  const { room: copy } = restart(room);
  assert.equal(copy.phase, 'lobby');
  assert.equal(copy.decks, 3);
  assert.equal(copy.turnSeconds, 20);
  assert.equal(copy.creatorIp, '10.0.0.1');
  assert.equal(copy.hostId, host.id);
  assert.equal(copy.findByToken(people[1].token).name, '乙');
  copy.addBot(host.id);
  copy.start(host.id);
  assert.notEqual(copy.phase, 'lobby');
  copy.destroy();
});

test('a snapshot that is not a room is refused', () => {
  assert.throws(() => Room.fromSnapshot({ format: 1, code: 'X', players: 'x', phase: 'lobby' }), /bad_snapshot/);
  assert.throws(() => Room.fromSnapshot({ format: 1, code: 'X', players: [], phase: 'playing', hand: null }));
});

// ---- hub + database ---------------------------------------------------------------

const SLOW = { turnMs: 100000, returnMs: 100000, botMs: 100000, nextHandMs: 100000 };

function playingRoom(hub, name = '甲') {
  const { room, player } = hub.createRoom(name);
  for (let i = 0; i < 3; i++) room.addBot(player.id);
  room.start(player.id);
  return { room, player };
}

test('hub: saveAll keeps rooms with humans; restoreAll brings them back once', () => {
  const db = openDatabase(':memory:');
  let now = 1_000_000;
  const hub = new Hub({ delays: SLOW, now: () => now });
  const { room, player } = playingRoom(hub);
  const { room: lobby, player: waiting } = hub.createRoom('乙');
  const { room: empty, player: gone } = playingRoom(hub, '丙');
  empty.markLeft(gone.id); // only bots are left playing
  hub.stop();
  assert.equal(hub.saveAll(db), 2);
  const again = new Hub({ delays: SLOW, now: () => now + 1000 });
  assert.equal(again.restoreAll(db), 2);
  assert.deepEqual([...again.rooms.keys()].sort(), [room.code, lobby.code].sort());
  assert.equal(again.authenticate(room.code, player.token).player.id, player.id);
  assert.equal(again.authenticate(lobby.code, waiting.token).player.id, waiting.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_snapshots').get().n, 0, 'snapshots are used once');
  now += 5000;
  assert.equal(new Hub({ delays: SLOW, now: () => now }).restoreAll(db), 0);
  for (const code of [...again.rooms.keys()]) again.deleteRoom(code);
});

test('hub: stale, corrupt and clashing snapshots are skipped without failing startup', () => {
  const db = openDatabase(':memory:');
  const now = 50_000_000;
  const hub = new Hub({ delays: SLOW, now: () => now });
  const { room } = playingRoom(hub);
  const good = JSON.stringify(room.toSnapshot());
  hub.deleteRoom(room.code);
  const insert = db.prepare('INSERT INTO room_snapshots (code, data, saved_at) VALUES (?, ?, ?)');
  insert.run(room.code, good, now - 1000);
  insert.run('OLD1', good.replace(room.code, 'OLD1'), now - SNAPSHOT_MAX_AGE_MS - 1);
  insert.run('BAD1', 'not json', now);
  insert.run('BAD2', JSON.stringify({ format: 1, code: 'BAD2', players: [], phase: 'playing' }), now);
  insert.run('BAD3', good, now); // the code inside does not match the row
  const errors = console.error;
  const warns = console.warn;
  console.error = () => {};
  console.warn = () => {};
  const fresh = new Hub({ delays: SLOW, now: () => now });
  try {
    assert.equal(fresh.restoreAll(db), 1);
  } finally {
    console.error = errors;
    console.warn = warns;
  }
  assert.deepEqual([...fresh.rooms.keys()], [room.code]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_snapshots').get().n, 0, 'every row is cleared, stale ones too');
  // A code that is already taken is not overwritten.
  insert.run(room.code, good, now);
  console.warn = () => {};
  try {
    assert.equal(fresh.restoreAll(db), 0);
  } finally {
    console.warn = warns;
  }
  for (const code of [...fresh.rooms.keys()]) fresh.deleteRoom(code);
});

test('hub: stop() closes streams without marking anyone offline or starting timers', () => {
  const hub = new Hub({ delays: SLOW });
  const { room, player } = playingRoom(hub);
  room.setOnline(player.id, true);
  let ended = 0;
  const res = { end: () => { ended += 1; } };
  hub.clients.set(room.code, new Map([[player.id, new Set([res])]]));
  hub.stop();
  assert.equal(ended, 1);
  assert.equal(room.timer, null);
  assert.equal(room.online.has(player.id), true);
  hub.deleteRoom(room.code);
});

test('migration 4 adds room_snapshots to a version 3 database and keeps its data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '510k-migrate-'));
  const file = path.join(dir, 'test.db');
  try {
    const db = openDatabase(file);
    db.prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES ('old', 'h', 's', 1)").run();
    db.exec('DROP TABLE room_snapshots; PRAGMA user_version = 3');
    db.close();
    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
    raw.close();
    const upgraded = openDatabase(file);
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM room_snapshots').get().n, 0);
    assert.equal(upgraded.prepare('SELECT username FROM users').get().username, 'old');
    upgraded.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- through the HTTP app ----------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startApp(accounts) {
  const app = createApp({ publicDir: path.join(root, 'public'), engineDir: path.join(root, 'engine'), delays: SLOW, accounts });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (pathname, body, expected = 200) => {
    const res = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await res.json();
    assert.equal(res.status, expected, JSON.stringify(payload));
    return payload;
  };
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  return { ...app, base, post, close };
}

test('HTTP: a room saved by one server is restored by the next, and the same token can act', async () => {
  const db = openDatabase(':memory:');
  const accounts = new Accounts(db);
  const first = await startApp(accounts);
  const host = await first.post('/api/rooms/create', { name: '甲' });
  for (let i = 0; i < 3; i++) await first.post('/api/rooms/add-bot', { code: host.code, token: host.token });
  const started = await first.post('/api/rooms/start', { code: host.code, token: host.token });
  const stream = await fetch(`${first.base}/api/events?room=${host.code}&token=${host.token}`);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read(); // the first view
  first.hub.stop();
  assert.equal(first.hub.saveAll(db), 1);
  for (;;) if ((await reader.read()).done) break; // the stream was closed by the server
  await first.close();

  const second = await startApp(accounts);
  try {
    assert.equal(second.hub.restoreAll(db), 1);
    const paused = await second.post('/api/rooms/pause', { code: host.code, token: host.token });
    assert.ok(paused.version > started.version);
    await second.post('/api/rooms/resume', { code: host.code, token: host.token });
    assert.equal((await second.post('/api/rooms/pause', { code: host.code, token: 'nope' }, 401)).error, 'bad_token');
    const again = await second.post('/api/rooms/join', { code: host.code, token: host.token });
    assert.equal(again.playerId, host.playerId);
    const events = await fetch(`${second.base}/api/events?room=${host.code}&token=${host.token}`);
    assert.equal(events.status, 200);
    const chunk = new TextDecoder().decode((await events.body.getReader().read()).value);
    const view = JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6));
    assert.equal(view.phase, 'playing');
    assert.equal(view.you.id, host.playerId);
  } finally {
    await second.close();
  }
});
