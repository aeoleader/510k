import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, prepareHand, completeReturns, recordHand, isMatchOver } from '../engine/match.js';
import { createHandState, apply, replay, ranking } from '../engine/game.js';
import { botAction } from '../engine/bot.js';
import { sumPoints } from '../engine/cards.js';
import { lowestCard } from '../engine/tribute.js';
import { findHighlights } from '../engine/highlights.js';
import { computeRatingDeltas } from '../engine/rating.js';

const MAX_ACTIONS = 5000;

function playHand(match) {
  const prepared = prepareHand(match);
  const hands = completeReturns(prepared, prepared.pendingReturns.map((r) => ({
    ...r, card: lowestCard(prepared.hands[r.from]),
  })));
  const initial = createHandState({ hands, teams: match.teams, leader: prepared.leader });
  let state = initial;
  const actions = [];
  const events = [];
  while (!state.over) {
    assert.ok(actions.length < MAX_ACTIONS, 'hand must terminate');
    const seat = state.turn;
    const top = state.trick?.top ?? null;
    const topSeat = state.trick?.topSeat;
    const opponents = state.hands.filter((h, i) => h.length && (match.teams ? match.teams[i] !== match.teams[seat] : i !== seat));
    const action = {
      seat,
      ...botAction({
        hand: state.hands[seat],
        top,
        topIsTeammate: Boolean(match.teams) && top !== null && match.teams[topSeat] === match.teams[seat] && topSeat !== seat,
        trickPoints: state.trick ? sumPoints(state.trick.cards) : 0,
        opponentMinCards: Math.min(...opponents.map((h) => h.length)),
      }),
    };
    const r = apply(state, action);
    state = r.state;
    actions.push(action);
    events.push(...r.events);
  }
  return { prepared, hands, initial, state, actions, events };
}

for (const [playerCount, decks] of [[4, 2], [5, 2], [6, 2], [7, 3], [8, 3], [6, 4]]) {
  test(`bots finish a full match: ${playerCount} players, ${decks} decks`, () => {
    let match = createMatch({ playerCount, decks, seed: playerCount * 1000 + decks });
    while (!isMatchOver(match)) {
      const { hands, initial, state, actions, events } = playHand(match);
      assert.equal(hands.flat().length, 54 * decks, 'no cards lost in tribute');
      const leftInHands = state.hands.flat();
      assert.equal(state.captured.reduce((a, b) => a + b, 0) + sumPoints(leftInHands), 100 * decks, 'points conserved');
      assert.deepEqual(replay(initial, actions).state, state, 'replay reproduces the hand');
      findHighlights({ events, teams: match.teams, decks });
      const lastEvent = events[events.length - 1];
      assert.equal(lastEvent.type, 'hand_end', 'the hand ends with a hand_end event');
      assert.deepEqual(lastEvent.ranking, ranking(state));
      ({ match } = recordHand(match, { ranking: ranking(state), finished: state.finished, captured: state.captured }));
    }
    const deltas = computeRatingDeltas(match, [...Array(playerCount).keys()].map((seat) => ({
      seat, rated: true, ratingBefore: 60, leftEarly: false,
    })));
    assert.equal(deltas.length, playerCount);
    assert.ok(deltas.every((d) => Number.isInteger(d.delta)));
  });
}
