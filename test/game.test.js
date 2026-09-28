import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandState, apply, replay, ranking, GameError } from '../engine/game.js';

const play = (seat, cards) => ({ seat, type: 'play', cards });
const pass = (seat) => ({ seat, type: 'pass' });

function run(state, actions) {
  return replay(state, actions);
}

test('rejects out-of-turn, foreign cards, invalid combos, weaker plays, leading pass', () => {
  const s = createHandState({ hands: [['3S0', '4S0'], ['5S0', '6S0'], ['7S0'], ['8S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GameError); return e.code; } return null; };
  assert.equal(code(() => apply(s, play(1, ['5S0']))), 'not_your_turn');
  assert.equal(code(() => apply(s, play(0, ['5S0']))), 'not_in_hand');
  assert.equal(code(() => apply(s, play(0, ['3S0', '4S0']))), 'invalid_combo');
  assert.equal(code(() => apply(s, pass(0))), 'must_lead');
  const s1 = apply(s, play(0, ['4S0'])).state;
  assert.equal(code(() => apply(s1, play(1, ['5S0', '6S0']))), 'invalid_combo');
  const s2 = createHandState({ hands: [['9S0', '4S0'], ['5S0', '6S0'], ['7S0'], ['8S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  const s3 = apply(s2, play(0, ['9S0'])).state;
  assert.equal(code(() => apply(s3, play(1, ['5S0']))), 'too_small');
});

test('rejects malformed actions', () => {
  const s = createHandState({ hands: [['3S0', '4S0'], ['5S0', '6S0'], ['7S0'], ['8S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GameError); return e.code; } return null; };
  assert.equal(code(() => apply(s, null)), 'bad_action');
  assert.equal(code(() => apply(s, 'x')), 'bad_action');
});

test('trick goes to last player after everyone else passes; points captured', () => {
  const s = createHandState({
    hands: [['5S0', '3S0'], ['TS0', '3H0'], ['KS0', '3C0'], ['4D0', '3D0']],
    teams: [0, 1, 0, 1], leader: 0, decks: 2,
  });
  const { state, events } = run(s, [play(0, ['5S0']), play(1, ['TS0']), play(2, ['KS0']), pass(3), pass(0), pass(1)]);
  assert.equal(state.captured[2], 25);
  assert.equal(state.turn, 2);
  assert.equal(state.trick, null);
  assert.deepEqual(events.filter((e) => e.type === 'trick').map((e) => [e.seat, e.points]), [[2, 25]]);
});

test('when the trick winner has gone out, lead goes to their next teammate still in', () => {
  const s = createHandState({
    hands: [['KS0'], ['3H0', '4H0'], ['3C0', '4C0'], ['3D0', '4D0'], ['3S0', '4S0'], ['5D0', '6D0']],
    teams: [0, 1, 0, 1, 0, 1], leader: 0, decks: 2,
  });
  const { state } = run(s, [play(0, ['KS0']), pass(1), pass(2), pass(3), pass(4), pass(5)]);
  assert.deepEqual(state.finished, [0]);
  assert.equal(state.captured[0], 10);
  assert.equal(state.turn, 2);
});

test('free-for-all: trick winner out, lead goes to next player in', () => {
  const s = createHandState({ hands: [['KS0'], ['3H0', '4H0'], ['3C0', '4C0'], ['3D0', '4D0'], ['3S0', '4S0']], teams: null, leader: 0, decks: 2 });
  const { state } = run(s, [play(0, ['KS0']), pass(1), pass(2), pass(3), pass(4)]);
  assert.equal(state.turn, 1);
});

test('team hand ends when one whole team is out; table points go to the last player', () => {
  const s = createHandState({
    hands: [['3S0'], ['9H0', '9D0'], ['KS0'], ['4D0', '4C0']],
    teams: [0, 1, 0, 1], leader: 0, decks: 2,
  });
  const { state, events } = run(s, [play(0, ['3S0']), pass(1), play(2, ['KS0'])]);
  assert.equal(state.over, true);
  assert.deepEqual(state.finished, [0, 2]);
  assert.equal(state.captured[2], 10);
  assert.deepEqual(ranking(state), [0, 2, 1, 3]);
  assert.equal(events.at(-1).type, 'hand_end');
});

test('free-for-all hand ends when one player is left', () => {
  const s = createHandState({ hands: [['3S0'], ['4S0'], ['5S0', '5H0'], ['6S0'], ['7S0']], teams: null, leader: 0, decks: 2 });
  const { state } = run(s, [play(0, ['3S0']), play(1, ['4S0']), pass(2), play(3, ['6S0']), play(4, ['7S0'])]);
  assert.equal(state.over, true);
  assert.deepEqual(ranking(state), [0, 1, 3, 4, 2]);
});

test('passes skip players who are out', () => {
  const s = createHandState({ hands: [['3S0', '8S0'], ['4S0'], ['5S0', '9S0'], ['6S0', '9H0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  const { state } = run(s, [play(0, ['3S0']), play(1, ['4S0']), play(2, ['5S0']), pass(3), pass(0)]);
  assert.equal(state.turn, 2, 'seat 1 is out, so after seats 3 and 0 pass the trick closes');
  assert.equal(state.captured[2], 5);
});

test('createHandState requires an integer decks count between 2 and 4', () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GameError); return e.code; } return null; };
  const hands = [['3S0', '4S0'], ['5S0'], ['6S0'], ['7S0']];
  assert.equal(code(() => createHandState({ hands, teams: [0, 1, 0, 1], leader: 0 })), 'bad_decks');
  assert.equal(code(() => createHandState({ hands, teams: [0, 1, 0, 1], leader: 0, decks: 1 })), 'bad_decks');
  assert.equal(code(() => createHandState({ hands, teams: [0, 1, 0, 1], leader: 0, decks: 5 })), 'bad_decks');
  assert.equal(code(() => createHandState({ hands, teams: [0, 1, 0, 1], leader: 0, decks: 2.5 })), 'bad_decks');
});

test('apply does not mutate the input state', () => {
  const s = createHandState({ hands: [['3S0', '4S0'], ['5S0'], ['6S0'], ['7S0']], teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  const copy = structuredClone(s);
  apply(s, play(0, ['3S0']));
  assert.deepEqual(s, copy);
});
