import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { HttpError } from '../server/http.js';
import { createHandState } from '../engine/game.js';

const FAST = { turnMs: 5, returnMs: 5, botMs: 1, nextHandMs: 1 };

function makeRoom(delays = FAST) {
  const changes = [];
  const room = new Room({ code: 'TEST', delays, onChange: (r) => changes.push(r.phase) });
  return { room, changes };
}

const waitFor = (predicate, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
    setTimeout(tick, 5);
  };
  tick();
});

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError); return e.code; }
  return null;
};

test('lobby: host, bots, decks, permissions and start requirements', () => {
  const { room } = makeRoom();
  const host = room.addHuman('甲');
  const guest = room.addHuman('乙');
  assert.equal(room.hostId, host.id);
  assert.equal(code(() => room.addBot(guest.id)), 'host_only');
  assert.equal(code(() => room.start(host.id)), 'not_enough_players');
  room.addBot(host.id);
  room.addBot(host.id);
  assert.equal(room.effectiveDecks(), 2);
  room.setDecks(host.id, 3);
  assert.equal(room.effectiveDecks(), 3);
  room.removePlayer(host.id, host.id);
  assert.equal(room.hostId, guest.id, 'host passes to the next human');
  for (let i = 0; i < 5; i++) room.addBot(guest.id);
  assert.equal(room.players.length, 8);
  assert.equal(code(() => room.addBot(guest.id)), 'room_full');
  room.destroy();
});

test('views hide other players\' cards', () => {
  const { room } = makeRoom({ ...FAST, botMs: 100000, turnMs: 100000, returnMs: 100000 });
  const a = room.addHuman('甲');
  const b = room.addHuman('乙');
  room.addBot(a.id);
  room.addBot(a.id);
  room.setOnline(a.id, true);
  room.setOnline(b.id, true);
  room.start(a.id);
  const view = room.viewFor(a.id);
  assert.equal(view.phase, 'playing');
  assert.equal(view.you.hand.length, 27);
  assert.deepEqual(view.players.map((p) => p.cards), [27, 27, 27, 27]);
  assert.ok(!JSON.stringify(view).includes(JSON.stringify(room.hand.hands[1])), 'no other hand in the view');
  room.destroy();
});

test('illegal actions are rejected with engine codes', () => {
  const { room } = makeRoom({ ...FAST, botMs: 100000, turnMs: 100000 });
  const a = room.addHuman('甲');
  const b = room.addHuman('乙');
  room.addBot(a.id);
  room.addBot(a.id);
  room.setOnline(a.id, true);
  room.setOnline(b.id, true);
  room.start(a.id);
  const turnPlayer = room.players[room.hand.turn];
  const other = room.players.find((p) => p.id !== turnPlayer.id && !p.isBot);
  assert.equal(code(() => room.pass(other.id)), 'not_your_turn');
  if (!turnPlayer.isBot) {
    assert.equal(code(() => room.pass(turnPlayer.id)), 'must_lead');
    assert.equal(code(() => room.play(turnPlayer.id, ['3S3'])), 'not_in_hand');
  }
  room.destroy();
});

for (const players of [4, 5, 8]) {
  test(`a full ${players}-player match runs to the end with bots and timeouts`, async () => {
    const { room } = makeRoom();
    const human = room.addHuman('甲'); // never online: auto-played like a disconnected player
    for (let i = 1; i < players; i++) room.addBot(human.id);
    room.start(human.id);
    await waitFor(() => room.phase === 'match_over');
    const view = room.viewFor(human.id);
    assert.equal(view.handNo, 10);
    assert.equal(room.match.handNo, 10);
    assert.equal(view.totals.length, players % 2 === 0 ? 2 : players);
    room.restart(human.id);
    assert.equal(room.phase, 'lobby');
    room.destroy();
  });
}

test('an online human who never acts is timed out: pass when following, smallest single when leading', async () => {
  const { room } = makeRoom({ ...FAST, turnMs: 20 });
  const human = room.addHuman('甲');
  room.setOnline(human.id, true);
  for (let i = 0; i < 3; i++) room.addBot(human.id);
  room.start(human.id);
  await waitFor(() => room.events.some((e) => e.seat === 0 && e.auto));
  const mine = room.events.filter((e) => e.seat === 0 && (e.type === 'play' || e.type === 'pass'));
  assert.ok(mine.every((e) => e.auto));
  assert.ok(mine.every((e) => e.type === 'pass' || e.cards.length === 1));
  room.destroy();
});

test('ratings: only logged-in humans are rated; leaving mid-match settles as a loss', async () => {
  const ratings = { 1: 60, 2: 200 };
  let recorded = null;
  const room = new Room({
    code: 'RATE',
    delays: FAST,
    accountView: (id) => ({ username: `u${id}`, rating: ratings[id] }),
    onMatchOver: (r) => { recorded = r.ratingResult; },
  });
  const a = room.addHuman('甲', { id: 1 });
  room.addHuman('乙', { id: 2 });
  room.addHuman('游客');
  room.addBot(a.id);
  room.start(a.id);
  room.markLeft(a.id);
  assert.equal(room.players[0].leftEarly, true);
  await waitFor(() => room.phase === 'match_over');
  assert.deepEqual(recorded.map((r) => r.before), [60, 200, null, null]);
  assert.equal(recorded[2].delta, null, 'guest');
  assert.equal(recorded[3].delta, null, 'bot');
  assert.ok(recorded[0].delta < 0, 'the leaver loses rating even if their team won');
  assert.equal(room.viewFor(a.id).ratings[0].after, 60 + recorded[0].delta);
  room.destroy();
});

test('the host picks the time per turn in the lobby; it drives the turn deadline', () => {
  const { room } = makeRoom({ turnMs: 15000, returnMs: 100000, botMs: 100000, nextHandMs: 100000 });
  const host = room.addHuman('甲');
  const guest = room.addHuman('乙');
  room.addBot(host.id);
  room.addBot(host.id);
  assert.equal(room.viewFor(host.id).turnSeconds, 15);
  assert.equal(code(() => room.setTurnSeconds(guest.id, 30)), 'host_only');
  room.setTurnSeconds(host.id, 30);
  assert.equal(room.viewFor(guest.id).turnSeconds, 30);
  room.setOnline(host.id, true);
  room.setOnline(guest.id, true);
  room.start(host.id);
  assert.equal(code(() => room.setTurnSeconds(host.id, 10)), 'in_progress');
  if (!room.isAutomatic(room.hand.turn)) assert.equal(room.deadlineSpan, 30000);
  room.destroy();
});

test('the host swaps seats in the lobby to change teams', () => {
  const { room } = makeRoom();
  const a = room.addHuman('甲');
  const b = room.addHuman('乙');
  const c = room.addHuman('丙');
  const d = room.addHuman('丁');
  const teamOf = (p) => room.players.indexOf(p) % 2;
  assert.deepEqual([a, b, c, d].map(teamOf), [0, 1, 0, 1]);
  assert.equal(code(() => room.swapSeats(b.id, a.id, b.id)), 'host_only');
  room.swapSeats(a.id, b.id, c.id);
  assert.deepEqual(room.players.map((p) => p.name), ['甲', '丙', '乙', '丁']);
  assert.equal(teamOf(b), teamOf(a), '乙 is now on 甲\'s team');
  assert.equal(code(() => room.swapSeats(a.id, a.id, 'nobody')), 'no_player');
  room.addBot(a.id);
  room.addBot(a.id);
  room.start(a.id);
  assert.equal(code(() => room.swapSeats(a.id, b.id, c.id)), 'in_progress');
  room.destroy();
});

test('played cards are recorded and shown in display order', () => {
  const { room } = makeRoom({ ...FAST, botMs: 100000, turnMs: 100000 });
  const players = ['甲', '乙', '丙', '丁'].map((n) => room.addHuman(n));
  for (const p of players) room.setOnline(p.id, true);
  room.start(players[0].id);
  room.hand = createHandState({
    hands: [['4S0', '7H0', '4D0', '7S0', '7C0', '9S0'], ['3S0'], ['3H0'], ['3D0']], teams: [0, 1, 0, 1], leader: 0, decks: 2,
  });
  room.play(players[0].id, ['4S0', '7H0', '4D0', '7S0', '7C0']);
  const order = ['7C0', '7H0', '7S0', '4D0', '4S0'];
  assert.deepEqual(room.seatActions[0].cards, order);
  assert.deepEqual(room.viewFor(players[1].id).trick.cards, order);
  assert.deepEqual(room.handRecord.actions[0].cards, order);
  room.destroy();
});
