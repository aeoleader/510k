import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identify } from '../engine/combos.js';
import { createHandState, apply } from '../engine/game.js';
import { botAction, botContext } from '../engine/bot.js';
import { compare, legacyBotAction } from '../scripts/bot-sim.js';

const top = (cards) => identify(cards);
const played = (action) => (action.type === 'play' ? [...action.cards].sort() : 'pass');

test('bot context: teammate on top, opponents still to act, card counts', () => {
  const hands = [['3S0', '4S0'], ['5S0', '6S0', '7S0'], ['8S0', '9S0', 'JS0', 'QS0'], ['AS0']];
  let state = createHandState({ hands, teams: [0, 1, 0, 1], leader: 0, decks: 2 });
  state = apply(state, { seat: 0, type: 'play', cards: ['3S0'] }).state;
  state = apply(state, { seat: 1, type: 'pass' }).state;
  const ctx = botContext(state, 2);
  assert.equal(ctx.topIsTeammate, true);
  assert.equal(ctx.opponentsToAct, 1);
  assert.equal(ctx.opponentMinCards, 1);
  assert.equal(ctx.teammateMinCards, 1);
  assert.deepEqual(ctx.hand, hands[2]);
  state = apply(state, { seat: 2, type: 'pass' }).state;
  assert.equal(botContext(state, 3).opponentsToAct, 0);
  assert.equal(botContext(state, 3).topIsTeammate, false);
});

test('protect points: lead a non-point single, keep 10s and Ks out of 三带一对', () => {
  assert.deepEqual(played(botAction({ hand: ['5S0', 'KD0', '9H0', 'JC0'], top: null })), ['9H0']);
  const t = top(['3S0', '3H0', '3C0', '4S0', '4H0']);
  assert.deepEqual(played(botAction({ hand: ['2S0', '2H0', '2C0', 'TS0', 'TH0', 'JS0', 'JH0', '9D0'], top: t })),
    ['2C0', '2H0', '2S0', 'JH0', 'JS0']);
  assert.deepEqual(played(botAction({ hand: ['KS0', 'KH0', 'KC0', 'TS0', 'TH0', '6S0', '6H0', '9D0'], top: t })),
    ['6H0', '6S0', 'KC0', 'KH0', 'KS0']);
});

test('feed a teammate only when no opponent can still answer', () => {
  const hand = ['KS0', '3D0', 'QH0', '8C0'];
  const ctx = { hand, top: top(['9S0']), topIsTeammate: true, trickPoints: 0 };
  assert.deepEqual(played(botAction({ ...ctx, opponentsToAct: 0 })), ['KS0']);
  assert.equal(played(botAction({ ...ctx, opponentsToAct: 1 })), 'pass');
  // No point card that follows: pass as before.
  assert.equal(played(botAction({ ...ctx, hand: ['3D0', 'QH0', '8C0', '4S0'], opponentsToAct: 0 })), 'pass');
});

test('bomb discipline: only for points, danger or going out; weakest that wins; never over a teammate', () => {
  const hand = ['7S0', '7H0', '7C0', '7D0', '3S0', '4H0', '6C0', '8D0', '9S0'];
  const t = top(['2D0']);
  assert.equal(played(botAction({ hand, top: t, trickPoints: 5, opponentMinCards: 10 })), 'pass');
  assert.deepEqual(played(botAction({ hand, top: t, trickPoints: 15, opponentMinCards: 10 })), ['7C0', '7D0', '7H0', '7S0']);
  assert.deepEqual(played(botAction({ hand, top: t, trickPoints: 0, opponentMinCards: 5 })), ['7C0', '7D0', '7H0', '7S0']);
  assert.equal(played(botAction({ hand, top: t, trickPoints: 40, topIsTeammate: true })), 'pass');
  const bombs = ['9S0', '9H0', '9C0', '9D0', '3S0', '3H0', '3C0', '3D0', '3S1', '4H0', '6C0'];
  assert.deepEqual(played(botAction({ hand: bombs, top: top(['8S0', '8H0', '8C0', '8D0']), trickPoints: 20 })),
    ['9C0', '9D0', '9H0', '9S0']);
});

test('keep bombs and 510K whole for normal plays until the hand is nearly empty', () => {
  const hand = ['7S0', '7H0', '7C0', '7D0', '3S0', '3H0', '4H0', '4S0', '5C0'];
  assert.equal(played(botAction({ hand, top: top(['6D0']), opponentMinCards: 10 })), 'pass');
  assert.deepEqual(played(botAction({ hand: ['7S0', '7H0', '7C0', '7D0', '9S0', '3H0', '4S0'], top: top(['6D0']) })), ['9S0']);
  assert.deepEqual(played(botAction({ hand: ['5S0', 'TH0', 'KC0', '9D0', '3S0', '4H0', '8C0'], top: top(['4D0']) })), ['8C0']);
  // Four cards left: splitting the 510K for a pair is fine; with five it is not.
  const qq = top(['QS0', 'QH0']);
  assert.deepEqual(played(botAction({ hand: ['5S0', 'TH0', 'KC0', 'KD0'], top: qq })), ['KC0', 'KD0']);
  assert.notDeepEqual(played(botAction({ hand: ['5S0', 'TH0', 'KC0', 'KD0', '3S0'], top: qq })), ['KC0', 'KD0']);
});

test('endgame: play the whole hand at once; stop an opponent about to go out', () => {
  assert.deepEqual(played(botAction({ hand: ['3S0', '4S0', '5H0', '6S0', '7S0'], top: null })), ['3S0', '4S0', '5H0', '6S0', '7S0']);
  assert.deepEqual(played(botAction({ hand: ['9S0', '9H0', '9C0', '9D0'], top: top(['AS0']), trickPoints: 0 })),
    ['9C0', '9D0', '9H0', '9S0']);
  // An opponent on one card: lead a pair, not a single; with singles only, lead the highest.
  assert.deepEqual(played(botAction({ hand: ['3S0', '3H0', '9D0', 'JC0'], top: null, opponentMinCards: 1 })), ['3H0', '3S0']);
  assert.deepEqual(played(botAction({ hand: ['3S0', '6H0', '9D0', 'JC0'], top: null, opponentMinCards: 1 })), ['JC0']);
  // Beat them even if it breaks a bomb.
  const hand = ['7S0', '7H0', '7C0', '7D0', '3S0', '3H0', '4H0', '4S0', '5C0'];
  assert.deepEqual(played(botAction({ hand, top: top(['6D0']), opponentMinCards: 2 })), ['7D0']);
});

test('simulation harness: new policy beats the legacy one on swapped seats', () => {
  const s = compare({ deals: 20, seed: 3 });
  assert.equal(s.hands, 40);
  assert.ok(s.wins > s.hands / 2, `won ${s.wins} of ${s.hands}`);
  assert.ok(s.margin > 0);
  assert.equal(legacyBotAction({ hand: ['3S0', '4S0'], top: top(['2S0']) }).type, 'pass');
});
