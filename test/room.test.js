import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { HttpError } from '../server/http.js';

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
