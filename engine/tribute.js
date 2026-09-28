import { isJoker, compareCards } from './cards.js';

export const PENALTY_PER_PLAYER = 20;

// A "side" is a team index (0/1) in team mode, or a seat index in free-for-all.
export const sideOf = (teams, seat) => (teams ? teams[seat] : seat);

// Settle one finished hand.
// Returns { score: number[] per side, penalties, headSide, winner (team or null in FFA), sweep }.
export function settleHand({ teams, captured, ranking, finished }) {
  const score = teams ? [0, 0] : captured.map(() => 0);
  captured.forEach((points, seat) => { score[sideOf(teams, seat)] += points; });

  const headSide = sideOf(teams, ranking[0]);
  const done = new Set(finished);
  const owed = new Map();
  for (const seat of ranking) {
    const side = sideOf(teams, seat);
    if (!done.has(seat) && side !== headSide) owed.set(side, (owed.get(side) || 0) + 1);
  }
  const penalties = [];
  for (const [side, count] of owed) {
    const amount = Math.min(PENALTY_PER_PLAYER * count, score[side]);
    score[side] -= amount;
    score[headSide] += amount;
    penalties.push({ from: side, to: headSide, count, amount });
  }

  if (!teams) return { score, penalties, headSide, winner: null, sweep: false };

  const size = teams.filter((t) => t === headSide).length;
  const sweep = finished.length >= size && finished.slice(0, size).every((seat) => teams[seat] === headSide);
  const other = 1 - headSide;
  const winner = sweep || score[headSide] >= score[other] ? headSide : other;
  return { score, penalties, headSide, winner, sweep };
}

// Who gives a card to whom at the start of the next hand.
export function tributePairs({ teams, ranking, winner, sweep }) {
  if (!teams) return [{ from: ranking[ranking.length - 1], to: ranking[0] }];
  const winners = ranking.filter((seat) => teams[seat] === winner);
  let givers = [];
  if (sweep) {
    givers = ranking.slice(-2).reverse();
  } else {
    for (let i = ranking.length - 1; i >= 0 && teams[ranking[i]] !== winner; i--) givers.push(ranking[i]);
  }
  return givers.map((from, i) => ({ from, to: winners[i] }));
}

// Give each tributer's highest card to their receiver, unless any tributer holds every joker.
// Returns { hands, resisted, given: [{ from, to, card }] }.
export function applyTribute({ hands, pairs, decks }) {
  if (pairs.length === 0) return { hands, resisted: false, given: [] };
  const allJokers = 2 * decks;
  if (pairs.some((p) => hands[p.from].filter(isJoker).length === allJokers)) {
    return { hands, resisted: true, given: [] };
  }
  const next = hands.map((h) => [...h]);
  const given = [];
  for (const { from, to } of pairs) {
    const card = [...next[from]].sort(compareCards).at(-1);
    next[from] = next[from].filter((c) => c !== card);
    next[to] = [...next[to], card].sort(compareCards);
    given.push({ from, to, card });
  }
  return { hands: next, resisted: false, given };
}

// The receiver (`from`) hands one card of their choice back to the tributer (`to`).
export function applyReturn({ hands, from, to, card }) {
  if (!hands[from].includes(card)) throw new Error('not_in_hand');
  const next = hands.map((h) => [...h]);
  next[from] = next[from].filter((c) => c !== card);
  next[to] = [...next[to], card].sort(compareCards);
  return next;
}

export const lowestCard = (hand) => [...hand].sort(compareCards)[0];
