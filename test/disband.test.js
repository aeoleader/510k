import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { HttpError } from '../server/http.js';

// Ending a match early: everyone still at the table has to agree, and nothing is rated.

const DELAYS = {
  turnMs: 100000, returnMs: 100000, botMs: 100000, nextHandMs: 100000, tributeMs: 100000, returnRevealMs: 100000,
  dealRoundMs: 100, claimGraceMs: 3000, restoreGraceMs: 20000, disbandVoteMs: 60000,
};

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

function setup({ humans = ['甲', '乙', '丙'], bots = 1 } = {}) {
  const clock = fakeClock();
  let recorded = 0;
  const room = new Room({
    code: 'DISB', delays: DELAYS, timers: clock.timers, now: clock.now, onMatchOver: () => { recorded += 1; },
  });
  const people = humans.map((n) => room.addHuman(n));
  for (let i = 0; i < bots; i++) room.addBot(people[0].id);
  for (const p of people) room.setOnline(p.id, true);
  room.start(people[0].id);
  return { room, clock, people, recorded: () => recorded };
}

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError); return e.code; }
  return null;
};

test('disband: every human at the table agrees, the room goes back to the lobby and nothing is recorded', () => {
  const { room, people: [a, b, c], recorded } = setup();
  room.proposeDisband(b.id);
  let v = room.viewFor(a.id);
  assert.deepEqual(v.disband.yes, [1]);
  assert.deepEqual(v.disband.voters, [0, 1, 2]);
  assert.equal(code(() => room.proposeDisband(a.id)), 'disband_pending');
  room.voteDisband(a.id, true);
  assert.notEqual(room.phase, 'lobby', 'still waiting on 丙');
  room.voteDisband(c.id, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.disband, null);
  assert.equal(room.match, null);
  assert.equal(recorded(), 0, 'a disbanded match is never recorded or rated');
  assert.equal(room.players.length, 4, 'everyone keeps their seat, bots included');
  v = room.viewFor(a.id);
  assert.equal(v.disband, null);
  assert.match(v.log.at(-1).text, /解散/);
  room.start(a.id); // the same table can start a fresh match
  assert.notEqual(room.phase, 'lobby');
  room.destroy();
});

test('disband: one "no" keeps the match going', () => {
  const { room, people: [a, b] } = setup();
  const phase = room.phase;
  room.proposeDisband(a.id);
  room.voteDisband(b.id, false);
  assert.equal(room.disband, null);
  assert.equal(room.phase, phase);
  assert.match(room.log.at(-1).text, /乙 不同意/);
  assert.equal(code(() => room.voteDisband(a.id, true)), 'no_disband');
  room.destroy();
});

test('disband: an unanswered request lapses', () => {
  const { room, clock, people: [a] } = setup();
  room.proposeDisband(a.id);
  clock.advance(DELAYS.disbandVoteMs - 1);
  assert.ok(room.disband);
  clock.advance(1);
  assert.equal(room.disband, null);
  assert.notEqual(room.phase, 'lobby');
  room.destroy();
});

test('disband: offline and departed seats do not block it; departed seats are dropped', () => {
  const { room, people: [a, b, c] } = setup();
  room.markLeft(c.id); // left mid-match: a bot plays on for them
  room.proposeDisband(a.id);
  assert.deepEqual(room.disband.yes, [0]);
  assert.equal(code(() => room.voteDisband(c.id, true)), 'left_match');
  room.setOnline(b.id, false); // the only one left to answer went offline
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.players.map((p) => p.name), ['甲', '乙', room.players[2].name]);
  assert.ok(room.players[2].isBot);
  room.destroy();
});

test('disband: alone with bots, asking is enough', () => {
  const { room, people: [a] } = setup({ humans: ['甲'], bots: 3 });
  room.proposeDisband(a.id);
  assert.equal(room.phase, 'lobby');
  room.destroy();
});

test('disband: only during a match', () => {
  const clock = fakeClock();
  const room = new Room({ code: 'LOBB', delays: DELAYS, timers: clock.timers, now: clock.now });
  const a = room.addHuman('甲');
  assert.equal(code(() => room.proposeDisband(a.id)), 'not_in_match');
  room.destroy();
});

test('disband: an open request survives a restart', () => {
  const { room, clock, people: [a, b, c] } = setup();
  room.proposeDisband(a.id);
  room.voteDisband(b.id, true);
  clock.advance(10000);
  const data = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  const restored = Room.fromSnapshot(data, { delays: DELAYS, timers: clock.timers, now: clock.now });
  assert.deepEqual(restored.disband.yes, [0, 1]);
  for (const p of [a, b, c]) restored.setOnline(p.id, true);
  restored.voteDisband(c.id, true);
  assert.equal(restored.phase, 'lobby');
  restored.destroy();
});
