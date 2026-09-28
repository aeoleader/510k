import { deal, teamsFor, createRng, clone } from './cards.js';
import { settleHand, tributePairs, applyTribute, applyReturn } from './tribute.js';

export const HANDS_PER_MATCH = 10;

export function createMatch({ playerCount, decks, seed }) {
  const teams = teamsFor(playerCount);
  return {
    playerCount,
    decks,
    teams,
    seed: seed >>> 0,
    handNo: 0, // hands completed so far
    totals: teams ? [0, 0] : Array(playerCount).fill(0),
    heads: Array(playerCount).fill(0),
    tails: Array(playerCount).fill(0),
    sweeps: [0, 0],
    last: null, // { ranking, winner, sweep } of the previous hand
  };
}

export const handSeed = (match, handNo) => (match.seed + Math.imul(handNo + 1, 0x9e3779b1)) >>> 0;

export function firstLeader(match) {
  return Math.floor(createRng(match.seed ^ 0x5f3759df)() * match.playerCount);
}

// Deal the next hand, hand leftovers to the leader and apply tribute.
// Card returns (receiver picks a card) are finished later with completeReturns().
// `leader` overrides who leads (and takes the leftover), e.g. whoever showed the black 3.
export function prepareHand(match, { leader: override = null } = {}) {
  const handNo = match.handNo;
  const seed = handSeed(match, handNo);
  const { hands: dealt, leftover } = deal({ playerCount: match.playerCount, decks: match.decks, seed });
  if (override !== null && !(Number.isInteger(override) && override >= 0 && override < match.playerCount)) {
    throw new Error('bad_leader');
  }
  const leader = override ?? (match.last ? match.last.ranking[0] : firstLeader(match));
  const withLeftover = dealt.map((h, i) => (i === leader ? [...h, ...leftover] : h));
  const pairs = match.last ? tributePairs({ teams: match.teams, ...match.last }) : [];
  const tribute = applyTribute({ hands: withLeftover, pairs, decks: match.decks });
  return {
    handNo,
    seed,
    leader,
    leftover,
    dealt: withLeftover,
    tribute: { pairs, resisted: tribute.resisted, given: tribute.given },
    hands: tribute.hands,
    pendingReturns: tribute.given.map((g) => ({ from: g.to, to: g.from })),
  };
}

// returns: [{ from, to, card }] — one per pending return.
export function completeReturns(prepared, returns) {
  const key = ({ from, to }) => `${from}->${to}`;
  const expected = new Set(prepared.pendingReturns.map(key));
  const seen = new Set();
  for (const r of returns) {
    const k = key(r);
    if (!expected.has(k) || seen.has(k)) throw new Error('bad_returns');
    seen.add(k);
  }
  if (seen.size !== expected.size) throw new Error('bad_returns');

  let hands = prepared.hands;
  for (const r of returns) hands = applyReturn({ hands, ...r });
  return hands;
}

// Fold a finished hand (final game state) into the match. Returns { match, result }.
export function recordHand(match, { ranking, finished, captured }) {
  const result = settleHand({ teams: match.teams, captured, ranking, finished });
  const next = clone(match);
  result.score.forEach((points, side) => { next.totals[side] += points; });
  next.heads[ranking[0]] += 1;
  next.tails[ranking[ranking.length - 1]] += 1;
  if (result.sweep) next.sweeps[result.winner] += 1;
  next.handNo += 1;
  next.last = { ranking: [...ranking], winner: result.winner, sweep: result.sweep };
  return { match: next, result };
}

export const isMatchOver = (match) => match.handNo >= HANDS_PER_MATCH;
