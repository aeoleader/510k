import { identify, beats } from './combos.js';
import { sumPoints } from './cards.js';

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// State of one hand in play. Treat as immutable: apply() returns a new state.
export function createHandState({ hands, teams, leader }) {
  if (!hands[leader]?.length) throw new GameError('bad_leader');
  return {
    hands: hands.map((h) => [...h]),
    teams,
    turn: leader,
    trick: null, // { top, topSeat, passes, cards }
    captured: hands.map(() => 0),
    finished: [],
    over: false,
    seq: 0,
  };
}

export const activeSeats = (s) => s.hands.flatMap((h, i) => (h.length ? [i] : []));

function nextActive(s, from) {
  const n = s.hands.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (s.hands[i].length) return i;
  }
  return -1;
}

function isHandOver(s) {
  if (!s.teams) return activeSeats(s).length <= 1;
  return [0, 1].some((t) => s.teams.every((team, i) => team !== t || s.hands[i].length === 0));
}

// Finished seats in finishing order, then unfinished seats by fewest cards left, then seat.
export function ranking(s) {
  const rest = activeSeats(s).sort((a, b) => s.hands[a].length - s.hands[b].length || a - b);
  return [...s.finished, ...rest];
}

function resolveTrick(s, emit) {
  const winner = s.trick.topSeat;
  const points = sumPoints(s.trick.cards);
  s.captured[winner] += points;
  emit({ type: 'trick', seat: winner, points, cards: s.trick.cards });
  s.trick = null;
  if (isHandOver(s)) {
    s.over = true;
    s.turn = -1;
    emit({ type: 'hand_end', ranking: ranking(s) });
    return;
  }
  if (s.hands[winner].length) {
    s.turn = winner;
    return;
  }
  // Winner already went out: lead passes to the next teammate still in, else the next player in.
  const n = s.hands.length;
  if (s.teams) {
    for (let k = 1; k < n; k++) {
      const i = (winner + k) % n;
      if (s.hands[i].length && s.teams[i] === s.teams[winner]) {
        s.turn = i;
        return;
      }
    }
  }
  s.turn = nextActive(s, winner);
}

// action: { seat, type: 'play', cards } | { seat, type: 'pass' }, optional auto: true.
export function apply(state, action) {
  if (state.over) throw new GameError('hand_over');
  if (action === null || typeof action !== 'object') throw new GameError('bad_action');
  if (action.seat !== state.turn) throw new GameError('not_your_turn');
  const s = structuredClone(state);
  const events = [];
  const emit = (e) => events.push({ seq: s.seq++, ...e });
  // The server sets `auto` itself when it plays a hand for an idle/absent seat;
  // it is never forwarded from a client action.
  const auto = Boolean(action.auto);

  if (action.type === 'pass') {
    if (!s.trick) throw new GameError('must_lead');
    s.trick.passes += 1;
    emit({ type: 'pass', seat: action.seat, auto });
    const others = activeSeats(s).filter((i) => i !== s.trick.topSeat).length;
    if (s.trick.passes >= others) resolveTrick(s, emit);
    else s.turn = nextActive(s, action.seat);
    return { state: s, events };
  }

  if (action.type !== 'play') throw new GameError('bad_action');
  const hand = s.hands[action.seat];
  const cards = action.cards;
  if (!Array.isArray(cards) || new Set(cards).size !== cards.length || !cards.every((c) => hand.includes(c))) {
    throw new GameError('not_in_hand');
  }
  const combo = identify(cards);
  if (!combo) throw new GameError('invalid_combo');
  if (s.trick && !beats(combo, s.trick.top)) throw new GameError('too_small');

  s.hands[action.seat] = hand.filter((c) => !cards.includes(c));
  if (!s.trick) s.trick = { top: null, topSeat: -1, passes: 0, cards: [] };
  s.trick.top = combo;
  s.trick.topSeat = action.seat;
  s.trick.passes = 0;
  s.trick.cards.push(...cards);
  emit({ type: 'play', seat: action.seat, cards: [...cards], combo, auto });

  if (s.hands[action.seat].length === 0) {
    s.finished.push(action.seat);
    emit({ type: 'finish', seat: action.seat, place: s.finished.length });
  }
  // A hand that ends mid-trick gives the table's points to the last player who played.
  if (isHandOver(s)) resolveTrick(s, emit);
  else s.turn = nextActive(s, action.seat);
  return { state: s, events };
}

// Re-run a hand from its initial state; used by replays and to verify recorded logs.
export function replay(initial, actions) {
  let state = initial;
  const events = [];
  for (const action of actions) {
    const r = apply(state, action);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}
