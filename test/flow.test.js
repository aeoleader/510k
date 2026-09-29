import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, DEFAULT_DELAYS } from '../server/room.js';
import { HttpError } from '../server/http.js';
import { createHandState } from '../engine/game.js';
import { recordHand, firstLeader, prepareHand } from '../engine/match.js';

// Dealing mode, tribute/return phases, pause, 不计时 and the hand review, on a fake clock.

const DELAYS = {
  turnMs: 10000, returnMs: 30000, botMs: 700, nextHandMs: 30000,
  tributeMs: 5000, returnRevealMs: 3000, dealRoundMs: 100, claimGraceMs: 3000,
};

// Fake timers and clock: advance(ms) runs every timer due by then, in order.
function fakeClock() {
  let t = 1000;
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

// humans: names; online: which of them have a stream open; bots added after.
function setup({ humans = ['甲', '乙', '丙', '丁'], online = humans, bots = 0, dealMode = false, random = () => 0, delays = DELAYS } = {}) {
  const clock = fakeClock();
  const room = new Room({ code: 'FLOW', delays, timers: clock.timers, now: clock.now, random });
  const people = humans.map((n) => room.addHuman(n));
  for (let i = 0; i < bots; i++) room.addBot(people[0].id);
  for (const p of people) if (online.includes(p.name)) room.setOnline(p.id, true);
  if (dealMode) room.setDealMode(people[0].id, true);
  return { room, clock, people, host: people[0] };
}

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError, String(e)); return e.code; }
  return null;
};

const isBlackThree = (c) => c.startsWith('3S');
const firstThree = (order) => order.findIndex(isBlackThree);

// Jump to a second hand with tribute (seat 3 gives to 0, seat 1 to 2), as if hand 1 ended that way.
function tributeHand(room) {
  room.match = recordHand(room.match, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0] }).match;
  while (prepareHand(room.match).tribute.resisted) room.match.seed += 1; // skip the rare 抗贡 deal
  room.startHand();
}

// End the current hand at once: seat 2 is already out, seat 0 plays its last card.
function endHand(room, seat0) {
  room.hand = { ...createHandState({ hands: [['3S0'], ['4S0'], [], ['5S0', '6S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 }), finished: [2] };
  room.play(seat0.id, ['3S0']);
}

test('delays passed without the new keys fall back to the defaults', () => {
  const room = new Room({ code: 'X', delays: { turnMs: 5, returnMs: 5, botMs: 1, nextHandMs: 1 } });
  assert.equal(room.delays.turnMs, 5);
  assert.equal(room.delays.tributeMs, DEFAULT_DELAYS.tributeMs);
  assert.deepEqual(
    [DEFAULT_DELAYS.turnMs, DEFAULT_DELAYS.returnMs, DEFAULT_DELAYS.botMs, DEFAULT_DELAYS.nextHandMs, DEFAULT_DELAYS.tributeMs,
      DEFAULT_DELAYS.returnRevealMs, DEFAULT_DELAYS.dealRoundMs, DEFAULT_DELAYS.claimGraceMs],
    [15000, 30000, 700, 30000, 5000, 3000, 120, 3000],
  );
});

test('dealMode off: no dealing phase, the usual first leader', () => {
  const { room, host } = setup();
  assert.equal(room.viewFor(host.id).dealMode, false);
  room.start(host.id);
  assert.equal(room.phase, 'playing');
  assert.equal(room.hand.turn, firstLeader(room.match));
  assert.equal(room.claimedBy, null);
  assert.equal(room.handRecord.tribute.claimedBy, null);
  const v = room.viewFor(host.id);
  assert.equal(v.dealRounds, null);
  assert.equal(v.claimedBy, null);
  room.destroy();
});

test('dealMode is a host-only lobby setting', () => {
  const { room, host, people } = setup();
  assert.equal(code(() => room.setDealMode(people[1].id, true)), 'host_only');
  room.setDealMode(host.id, true);
  assert.equal(room.viewFor(people[1].id).dealMode, true);
  room.start(host.id);
  assert.equal(code(() => room.setDealMode(host.id, false)), 'in_progress');
  room.destroy();
});

test('dealing: each player sees only their revealed cards in dealt order', () => {
  const { room, clock, host, people } = setup({ dealMode: true, online: [] });
  room.start(host.id);
  assert.equal(room.phase, 'dealing');
  let v = room.viewFor(host.id);
  assert.equal(v.dealRounds, 0);
  assert.equal(v.dealTotalRounds, 27);
  assert.equal(v.dealRoundMs, 100);
  assert.equal(v.dealStartedAt, clock.now());
  assert.deepEqual(v.you.hand, []);
  clock.advance(550);
  v = room.viewFor(people[1].id);
  assert.equal(v.dealRounds, 5);
  assert.deepEqual(v.you.hand, room.dealing.order[1].slice(0, 5));
  assert.deepEqual(v.players.map((p) => p.cards), [5, 5, 5, 5]);
  assert.ok(!JSON.stringify(v).includes(room.dealing.order[0][6]), 'unrevealed cards never leave the server');
  assert.equal(v.tribute, null);
  room.destroy();
});

test('dealing: a view is pushed every round, and the wakeups stop once the deal is out', () => {
  const { room, clock, host } = setup({ dealMode: true, online: [] });
  const pushes = [];
  room.onChange = (r) => pushes.push(r.phase === 'dealing' ? r.dealRounds() : r.phase);
  room.start(host.id);
  clock.advance(1000);
  assert.deepEqual(pushes.slice(0, 11), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  clock.advance(27 * 100 - 1000 + 1500); // into the claim grace (nobody holds a claiming bot)
  assert.equal(room.phase, 'dealing');
  assert.ok(clock.pending.size <= 1, 'one timer for the grace, not a busy loop');
  room.destroy();
});

test('亮黑3: not before it is revealed, first claim wins, the deal goes on, the winner leads with the leftover', () => {
  // Five humans: 21 cards each and 3 leftover cards for the leader.
  const names = ['甲', '乙', '丙', '丁', '戊'];
  const { room, clock, host, people } = setup({ humans: names, dealMode: true });
  room.start(host.id);
  const order = room.dealing.order;
  const holders = order.map((o, seat) => [seat, firstThree(o)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  if (!holders.length) return room.destroy(); // both black 3s in the leftover: covered by another test
  const [seat, index] = holders[0];
  const claimer = people[seat];
  clock.advance(index * 100); // `index` rounds shown: the 3 is the next card
  assert.equal(code(() => room.claimThree(claimer.id)), 'no_black_three');
  clock.advance(100);
  room.claimThree(claimer.id);
  assert.equal(room.claimedBy, seat);
  const other = people[(seat + 1) % 5];
  if (index + 1 < 21) { // a claim on the last round ends the deal at once (tested separately)
    assert.equal(code(() => room.claimThree(other.id)), 'already_claimed');
    assert.equal(code(() => room.claimThree(claimer.id)), 'already_claimed');
    assert.equal(room.phase, 'dealing', 'dealing continues after a claim');
    assert.equal(room.viewFor(other.id).claimedBy, seat);
  }
  clock.advance(21 * 100);
  assert.equal(room.phase, 'playing');
  assert.equal(room.hand.turn, seat);
  assert.equal(room.hand.hands[seat].length, 24, 'the leftover goes to the claim winner');
  assert.equal(room.handRecord.leader, seat);
  assert.equal(room.handRecord.tribute.claimedBy, seat);
  assert.equal(code(() => room.claimThree(claimer.id)), 'not_dealing');
  room.destroy();
});

test('亮黑3: a player without a black 3 gets no_black_three', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  clock.advance(27 * 100);
  const without = room.dealing.order.findIndex((o) => !o.some(isBlackThree));
  if (without >= 0) assert.equal(code(() => room.claimThree(people[without].id)), 'no_black_three');
  room.destroy();
});

for (const [label, random, wait] of [['soonest', () => 0, 1000], ['latest', () => 0.99999, 2500]]) {
  test(`bots show the black 3 ${wait} ms after it is dealt to them (${label})`, () => {
    // Retry deals until a bot holds a black 3 (random seeds).
    for (let attempt = 0; attempt < 50; attempt++) {
      const { room, clock, host } = setup({ humans: ['甲'], bots: 3, dealMode: true, random });
      room.start(host.id);
      const botHolders = room.dealing.order.map((o, seat) => [seat, firstThree(o)]).filter(([seat, i]) => seat > 0 && i >= 0);
      if (!botHolders.length) { room.destroy(); continue; }
      const [seat, index] = botHolders.sort((a, b) => a[1] - b[1])[0];
      const at = (index + 1) * 100 + wait;
      clock.advance(at - 1);
      assert.equal(room.claimedBy, null);
      clock.advance(1);
      assert.equal(room.claimedBy, seat);
      room.destroy();
      return;
    }
    assert.fail('no deal gave a bot a black 3');
  });
}

test('nobody claims: grace after the deal, then a random black 3 holder leads', () => {
  const { room, clock, host } = setup({ dealMode: true, online: [] }); // offline humans never claim
  room.start(host.id);
  const holders = room.dealing.order.flatMap((o, seat) => (o.some(isBlackThree) ? [seat] : []));
  clock.advance(27 * 100);
  assert.equal(room.phase, 'dealing');
  assert.equal(room.viewFor(host.id).dealRounds, 27);
  assert.equal(room.deadline, clock.now() + 3000, 'the grace shows as a deadline');
  clock.advance(2999);
  assert.equal(room.phase, 'dealing');
  clock.advance(1);
  assert.equal(room.phase, 'playing');
  assert.equal(room.claimedBy, null);
  const expected = holders.length ? holders[0] : 0; // random() = 0 picks the first
  assert.equal(room.hand.turn, expected);
  room.destroy();
});

test('nobody holds a black 3 (all in the leftover): a random seat leads', () => {
  const { room, clock, host } = setup({ dealMode: true, online: [], random: () => 0.99 });
  room.start(host.id);
  room.dealing.order = room.dealing.order.map((o) => o.map((c) => (isBlackThree(c) ? '4D0' : c)));
  clock.advance(27 * 100 + 3000);
  assert.equal(room.phase, 'playing');
  assert.equal(room.hand.turn, 3);
  room.destroy();
});

test('dealMode: every hand is dealt and the previous head no longer leads', () => {
  const { room, clock, host } = setup({ dealMode: true, online: [] });
  room.start(host.id);
  clock.advance(27 * 100 + 3000);
  tributeHand(room); // previous head: seat 0
  assert.equal(room.phase, 'dealing');
  const holders = room.dealing.order.flatMap((o, seat) => (o.some(isBlackThree) ? [seat] : []));
  clock.advance(27 * 100 + 3000);
  assert.equal(room.phase, 'tribute');
  assert.equal(room.prepared.leader, holders.length ? holders[0] : 0);
  room.destroy();
});

test('tribute is public, then returns stay private until return_reveal, then play', () => {
  const { room, clock, host, people } = setup({ online: ['甲', '乙', '丙', '丁'] });
  room.start(host.id);
  tributeHand(room);
  assert.equal(room.phase, 'tribute');
  const given = room.prepared.tribute.given;
  assert.equal(given.length, 2);
  assert.deepEqual(room.viewFor(people[1].id).tribute.given, given, 'everyone sees the tribute cards');
  assert.equal(code(() => room.submitReturn(host.id, room.prepared.hands[0][0])), 'not_returning');
  clock.advance(4999);
  assert.equal(room.phase, 'tribute');
  clock.advance(1);
  assert.equal(room.phase, 'returning');
  assert.equal(room.deadlineSpan, 30000);
  const card0 = room.prepared.hands[0][0];
  room.submitReturn(host.id, card0); // seat 0 returns to seat 3
  assert.equal(room.viewFor(people[3].id).tribute.returns[0].card, card0);
  assert.equal(room.viewFor(people[1].id).tribute.returns[0].card, null, 'hidden from others while returning');
  room.submitReturn(people[2].id, room.prepared.hands[2][0]);
  assert.equal(room.phase, 'return_reveal');
  assert.equal(room.viewFor(people[1].id).tribute.returns[0].card, card0, 'public in return_reveal');
  assert.ok(room.viewFor(people[3].id).you.hand.includes(card0));
  clock.advance(3000);
  assert.equal(room.phase, 'playing');
  assert.equal(room.viewFor(people[1].id).tribute.returns[0].card, card0);
  room.destroy();
});

test('不计时: an online human is never timed out; an offline one is auto-played', () => {
  const { room, clock, host, people } = setup({ online: ['甲', '乙', '丙', '丁'] });
  room.setTurnSeconds(host.id, 0);
  assert.equal(room.viewFor(host.id).turnSeconds, 0);
  room.start(host.id);
  const seat = room.hand.turn;
  assert.equal(room.deadline, null);
  clock.advance(10 * 60 * 1000);
  assert.equal(room.hand.turn, seat);
  assert.equal(room.actions.length, 0);
  room.setOnline(people[seat].id, false);
  clock.advance(700);
  assert.equal(room.actions.length, 1);
  assert.equal(room.actions[0].auto, true);
  room.destroy();
});

test('不计时: no return deadline for online receivers; auto seats still return', () => {
  const { room, clock, host, people } = setup({ online: ['甲', '乙', '丙'] }); // seat 3 offline
  room.setTurnSeconds(host.id, 0);
  room.start(host.id);
  tributeHand(room);
  clock.advance(5000);
  assert.equal(room.phase, 'returning');
  assert.equal(room.deadline, null);
  clock.advance(60 * 60 * 1000);
  assert.equal(room.phase, 'returning');
  room.setOnline(people[2].id, false); // seat 2 must return to seat 1; now automatic
  clock.advance(700);
  assert.equal(room.returns.find((r) => r.from === 2).card !== null, true);
  assert.equal(room.returns.find((r) => r.from === 0).card, null);
  room.destroy();
});

test('pause: host only, allowed phases, actions refused, deadline frozen and restored', () => {
  const { room, clock, host, people } = setup();
  assert.equal(code(() => room.pause(host.id)), 'cannot_pause');
  room.start(host.id);
  const seat = room.hand.turn;
  const player = people[seat];
  assert.equal(code(() => room.pause(people[1].id)), 'host_only');
  assert.equal(code(() => room.resume(host.id)), 'not_paused');
  clock.advance(4000);
  room.pause(host.id);
  assert.equal(code(() => room.pause(host.id)), 'paused');
  let v = room.viewFor(player.id);
  assert.equal(v.paused, true);
  assert.equal(v.deadline, null);
  assert.equal(v.pausedRemaining, 6000);
  clock.advance(60000);
  assert.equal(room.actions.length, 0, 'nothing times out while paused');
  assert.equal(code(() => room.pass(player.id)), 'paused');
  assert.equal(code(() => room.play(player.id, [room.hand.hands[seat][0]])), 'paused');
  room.resume(host.id);
  v = room.viewFor(player.id);
  assert.equal(v.paused, false);
  assert.equal(v.deadline, clock.now() + 6000, 'the remaining time is restored');
  clock.advance(5999);
  assert.equal(room.actions.length, 0);
  clock.advance(1);
  assert.equal(room.actions.length, 1);
  assert.equal(room.actions[0].auto, true);
  room.destroy();
});

test('pause freezes the deal clock and claims', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  clock.advance(500);
  room.pause(host.id);
  clock.advance(10000);
  assert.equal(room.viewFor(host.id).dealRounds, 5);
  assert.equal(room.phase, 'dealing');
  assert.equal(code(() => room.claimThree(people[1].id)), 'paused');
  room.resume(host.id);
  assert.equal(room.viewFor(host.id).dealRounds, 5, 'no card was revealed while paused');
  assert.equal(room.viewFor(host.id).dealStartedAt, clock.now() - 500);
  clock.advance(100);
  assert.equal(room.viewFor(host.id).dealRounds, 6);
  room.destroy();
});

test('pause in tribute, return and review phases keeps their remaining time', () => {
  const { room, clock, host, people } = setup();
  room.start(host.id);
  tributeHand(room);
  clock.advance(2000);
  room.pause(host.id);
  clock.advance(100000);
  assert.equal(room.phase, 'tribute');
  room.resume(host.id);
  clock.advance(2999);
  assert.equal(room.phase, 'tribute');
  clock.advance(1);
  assert.equal(room.phase, 'returning');
  room.pause(host.id);
  assert.equal(code(() => room.submitReturn(host.id, room.prepared.hands[0][0])), 'paused');
  room.resume(host.id);
  room.submitReturn(host.id, room.prepared.hands[0][0]);
  room.submitReturn(people[2].id, room.prepared.hands[2][0]);
  assert.equal(room.phase, 'return_reveal');
  room.pause(host.id);
  clock.advance(100000);
  assert.equal(room.phase, 'return_reveal');
  room.resume(host.id);
  clock.advance(3000);
  assert.equal(room.phase, 'playing');
  room.destroy();
});

test('the host leaving keeps the pause; the new host can resume', () => {
  const { room, host, people } = setup();
  room.start(host.id);
  room.pause(host.id);
  room.markLeft(host.id);
  assert.equal(room.paused, true);
  assert.equal(room.hostId, people[1].id);
  assert.equal(code(() => room.resume(host.id)), 'host_only');
  room.resume(people[1].id);
  assert.equal(room.paused, false);
  room.destroy();
});

test('hand review: remaining cards, ready set, all ready starts the next hand early', () => {
  const { room, host, people } = setup({ humans: ['甲', '乙'], online: ['甲', '乙'], bots: 2 });
  room.start(host.id);
  room.hand = { ...createHandState({ hands: [['3S0'], ['4S0'], [], ['5S0', '6S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 }), finished: [2] };
  room.play(host.id, ['3S0']);
  assert.equal(room.phase, 'hand_over');
  const v = room.viewFor(people[1].id);
  assert.deepEqual(v.result.remaining, [[], ['4S0'], [], ['5S0', '6S0']]);
  assert.equal(room.deadlineSpan, 30000);
  assert.deepEqual(v.ready, []);
  room.markReady(host.id);
  assert.equal(room.phase, 'hand_over');
  assert.deepEqual(room.viewFor(host.id).ready, [0]);
  room.pause(host.id);
  assert.equal(code(() => room.markReady(people[1].id)), 'paused');
  assert.equal(code(() => room.nextHand(host.id)), 'paused');
  room.resume(host.id);
  room.markReady(people[1].id);
  assert.ok(['tribute', 'playing'].includes(room.phase), 'everyone ready: the next hand starts');
  assert.deepEqual(room.viewFor(host.id).ready, []);
  assert.equal(code(() => room.markReady(host.id)), 'not_hand_over');
  room.destroy();
});

test('hand review: offline players do not hold up the next hand; the deadline still applies', () => {
  const { room, host, people } = setup({ online: ['甲', '乙'] });
  room.start(host.id);
  endHand(room, host);
  room.markReady(host.id);
  assert.equal(room.phase, 'hand_over');
  room.setOnline(people[1].id, false); // the only other online human drops: everyone left is ready
  assert.ok(['tribute', 'playing'].includes(room.phase));
  const again = setup();
  again.room.start(again.host.id);
  endHand(again.room, again.host);
  again.clock.advance(29999);
  assert.equal(again.room.phase, 'hand_over');
  again.clock.advance(1);
  assert.ok(['tribute', 'playing'].includes(again.room.phase));
  room.destroy();
  again.room.destroy();
});

// Find the black 3 holder that is dealt first: [seat, index in their dealt order], or null.
function firstHolder(room) {
  const holders = room.dealing.order.map((o, seat) => [seat, firstThree(o)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return holders[0] ?? null;
}

test('亮黑3 during the grace after the deal ends the deal at once', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  const holder = firstHolder(room);
  if (!holder) return room.destroy();
  clock.advance(27 * 100 + 1000);
  assert.equal(room.phase, 'dealing');
  assert.equal(room.dealing.ended, true, 'in the claim grace');
  room.claimThree(people[holder[0]].id);
  assert.notEqual(room.phase, 'dealing');
  assert.equal(room.prepared.leader, holder[0]);
  room.destroy();
});

test('亮黑3 exactly when the last round is revealed ends the deal at once', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  const holder = firstHolder(room);
  if (!holder) return room.destroy();
  clock.advance(27 * 100);
  assert.equal(room.dealRounds(), room.dealing.total);
  room.claimThree(people[holder[0]].id);
  assert.notEqual(room.phase, 'dealing');
  assert.equal(room.prepared.leader, holder[0]);
  room.destroy();
});

test('pause during the claim grace, then resume: the grace keeps its remaining time', () => {
  const { room, clock, host } = setup({ dealMode: true, online: ['甲'] });
  room.start(host.id);
  clock.advance(27 * 100 + 1000);
  room.pause(host.id);
  assert.equal(room.pausedRemaining, 2000);
  clock.advance(60000);
  assert.equal(room.phase, 'dealing');
  room.resume(host.id);
  assert.equal(room.deadline, clock.now() + 2000);
  clock.advance(1999);
  assert.equal(room.phase, 'dealing');
  clock.advance(1);
  assert.notEqual(room.phase, 'dealing');
  room.destroy();
});

test('pause on a bot\'s turn: the bot waits, then plays after the resume', () => {
  const { room, clock, host } = setup({ humans: ['甲'], bots: 3 });
  room.start(host.id);
  const runUntilBot = () => { for (let i = 0; i < 200 && !room.players[room.hand.turn].isBot; i++) clock.advance(50); };
  runUntilBot();
  assert.equal(room.players[room.hand.turn].isBot, true);
  const played = room.actions.length;
  room.pause(host.id);
  assert.equal(room.pausedRemaining, null, 'a bot turn has no deadline');
  clock.advance(60000);
  assert.equal(room.actions.length, played);
  room.resume(host.id);
  clock.advance(DELAYS.botMs - 1);
  assert.equal(room.actions.length, played);
  clock.advance(1);
  assert.equal(room.actions.length, played + 1);
  room.destroy();
});

test('the host leaving mid-dealing while paused: still paused, the new host resumes the deal', () => {
  const { room, clock, host, people } = setup({ dealMode: true });
  room.start(host.id);
  clock.advance(500);
  room.pause(host.id);
  room.markLeft(host.id);
  assert.equal(room.paused, true);
  assert.equal(room.phase, 'dealing');
  assert.equal(room.hostId, people[1].id);
  clock.advance(10000);
  assert.equal(room.dealRounds(), 5);
  assert.equal(code(() => room.claimThree(host.id)), 'paused');
  room.resume(people[1].id);
  clock.advance(100);
  assert.equal(room.dealRounds(), 6);
  room.destroy();
});

test('resume re-checks the review: if everyone left is ready, the next hand starts', () => {
  const { room, host, people } = setup({ humans: ['甲', '乙'], bots: 2 });
  room.start(host.id);
  endHand(room, host);
  room.markReady(host.id);
  room.pause(host.id);
  room.setOnline(people[1].id, false); // the one not ready drops while paused
  assert.equal(room.phase, 'hand_over');
  room.resume(host.id);
  assert.ok(['tribute', 'playing'].includes(room.phase));
  room.destroy();
});

test('抗贡 is shown in the tribute phase for tributeMs, then play starts without returns', () => {
  const { room, clock, host } = setup();
  room.start(host.id);
  room.match = recordHand(room.match, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0] }).match;
  let tries = 0;
  while (!prepareHand(room.match).tribute.resisted) {
    room.match.seed += 1;
    assert.ok((tries += 1) < 100000, 'no 抗贡 deal found');
  }
  room.startHand();
  assert.equal(room.phase, 'tribute');
  const v = room.viewFor(host.id);
  assert.equal(v.tribute.resisted, true);
  assert.deepEqual(v.tribute.given, []);
  assert.equal(room.deadline, clock.now() + DELAYS.tributeMs);
  clock.advance(DELAYS.tributeMs - 1);
  assert.equal(room.phase, 'tribute');
  clock.advance(1);
  assert.equal(room.phase, 'playing');
  assert.deepEqual(room.returns, []);
  room.destroy();
});

test('a failed deal finish leaves the dealing state intact', () => {
  const { room, host } = setup({ dealMode: true });
  room.start(host.id);
  assert.throws(() => room.finishDeal(99), /bad_leader/);
  assert.equal(room.phase, 'dealing');
  assert.ok(room.dealing);
  room.destroy();
});

// ---- robustness: host away while paused, illegal bot moves, failing timers, reconnects -------------

test('paused with the host offline too long: an online human becomes host', () => {
  const { room, clock, host, people } = setup({ humans: ['甲', '乙', '丙', '丁'], online: ['甲', '乙'] });
  room.start(host.id);
  room.pause(host.id);
  room.setOnline(host.id, false);
  clock.advance(DEFAULT_DELAYS.hostAwayMs - 1);
  assert.equal(room.hostId, host.id);
  clock.advance(1);
  assert.equal(room.hostId, people[1].id);
  assert.ok(room.log.some((l) => l.text === '房主离线，乙 成为房主'));
  assert.equal(room.paused, true);
  room.resume(people[1].id);
  assert.equal(room.paused, false);
  room.destroy();
});

test('paused with the host away and nobody online: the host role moves once someone comes online', () => {
  const { room, clock, host, people } = setup({ humans: ['甲', '乙', '丙', '丁'], online: ['甲'] });
  room.start(host.id);
  room.pause(host.id);
  room.setOnline(host.id, false);
  clock.advance(2 * DEFAULT_DELAYS.hostAwayMs);
  assert.equal(room.hostId, host.id, 'nobody online to take over');
  room.setOnline(people[2].id, true);
  clock.advance(0);
  assert.equal(room.hostId, people[2].id);
  room.destroy();
});

test('the host coming back before hostAwayMs keeps the role', () => {
  const { room, clock, host } = setup({ online: ['甲', '乙'] });
  room.start(host.id);
  room.pause(host.id);
  room.setOnline(host.id, false);
  clock.advance(DEFAULT_DELAYS.hostAwayMs - 1000);
  room.setOnline(host.id, true);
  clock.advance(10 * DEFAULT_DELAYS.hostAwayMs);
  assert.equal(room.hostId, host.id);
  room.destroy();
});

const quietly = (fn) => {
  const error = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = error; }
};

test('an illegal move from the bot policy falls back to a legal one and the hand goes on', () => {
  const { room, clock, host } = setup({ humans: ['甲'], online: [], bots: 3 });
  room.start(host.id);
  room.botPolicy = () => ({ type: 'play', cards: ['NOPE'] });
  quietly(() => {
    for (let i = 0; i < 2000 && room.phase === 'playing'; i++) clock.advance(DELAYS.botMs);
  });
  assert.equal(room.phase, 'hand_over', 'the hand was played to the end');
  assert.ok(room.actions.length > 0);
  room.destroy();
});

test('a failing automatic action is rescheduled a few times, then stops instead of spinning', () => {
  const { room, clock, host } = setup({ humans: ['甲'], online: [], bots: 3 });
  room.start(host.id);
  let calls = 0;
  room.botPolicy = () => { calls += 1; throw new TypeError('boom'); };
  quietly(() => clock.advance(100 * DELAYS.botMs));
  assert.equal(calls, 4, 'the first try and three retries');
  assert.equal(clock.pending.size, 0);
  // A transient failure: the retry plays on.
  const { room: other, clock: c, host: h } = setup({ humans: ['甲'], online: [], bots: 3 });
  other.start(h.id);
  let fails = 1;
  const real = other.botPolicy;
  other.botPolicy = (hand, seat) => { if (fails-- > 0) throw new TypeError('once'); return real(hand, seat); };
  quietly(() => c.advance(3 * DELAYS.botMs));
  assert.ok(other.actions.length >= 1);
  room.destroy();
  other.destroy();
});

test('reconnecting mid-turn keeps the running turn clock', () => {
  const { room, clock, host } = setup({ humans: ['甲'], bots: 3 });
  room.start(host.id);
  for (let i = 0; i < 400 && room.hand.turn !== 0; i++) clock.advance(50);
  assert.equal(room.hand.turn, 0);
  const deadline = room.deadline;
  const played = room.actions.length;
  clock.advance(2000);
  for (let i = 0; i < 2; i++) {
    room.setOnline(host.id, false);
    clock.advance(100);
    room.setOnline(host.id, true);
    assert.equal(room.deadline, deadline, 'the deadline is not extended');
  }
  clock.advance(deadline - clock.now() - 1);
  assert.equal(room.actions.length, played);
  clock.advance(1);
  assert.equal(room.actions.length, played + 1, 'timed out on the original deadline');
  room.destroy();
});

test('the view lists every play, pass and won trick of the hand for the play log', () => {
  const { room, host, people } = setup();
  room.start(host.id);
  assert.deepEqual(room.viewFor(host.id).plays, []);
  room.hand = createHandState({ hands: [['3S0', '9S0'], ['4S0', '8S0'], ['5S0', '7S0'], ['6S0', 'TS0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  room.play(people[0].id, ['3S0']);
  room.play(people[1].id, ['4S0']);
  room.pass(people[2].id);
  room.pass(people[3].id);
  room.pass(people[0].id);
  const plays = room.viewFor(people[2].id).plays;
  assert.deepEqual(plays[0], { seat: 0, cards: ['3S0'], type: 'single', auto: false });
  assert.deepEqual(plays[2], { seat: 2, pass: true, auto: false });
  assert.equal(plays.at(-1).trick, true);
  assert.equal(plays.at(-1).seat, 1);
  room.destroy();
});
