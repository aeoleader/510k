import { isJoker } from './cards.js';

// 发牌平衡 (host-only lobby setting): the side far behind sometimes gets the better of two deals.

export const BALANCE_MIN_DEFICIT = 100;

// Chance of keeping the better of the two deals: 25% at a 100-point deficit, rising to 50% at 300 and above.
export const balanceChance = (deficit) => Math.min(0.5, 0.25 + (deficit - BALANCE_MIN_DEFICIT) / 800);

// The side to favour before the next hand, from the match totals so far: { seats, deficit }, or null
// on the first hand or when nobody is at least BALANCE_MIN_DEFICIT behind.
// Teams: the trailing team, deficit = leader's total - trailer's. FFA: the lowest seat (first on a tie),
// deficit = average of the others - lowest.
export function balanceTarget(match) {
  if (match.handNo === 0) return null;
  const { totals, teams } = match;
  let seats;
  let deficit;
  if (teams) {
    const trailing = totals[0] < totals[1] ? 0 : 1;
    deficit = totals[1 - trailing] - totals[trailing];
    seats = teams.flatMap((t, seat) => (t === trailing ? [seat] : []));
  } else {
    const lowest = totals.indexOf(Math.min(...totals));
    const others = totals.reduce((sum, t) => sum + t, 0) - totals[lowest];
    deficit = others / (totals.length - 1) - totals[lowest];
    seats = [lowest];
  }
  return deficit >= BALANCE_MIN_DEFICIT ? { seats, deficit } : null;
}

const LOW_SINGLE_MAX = 9; // 3-9 held once are hard to get rid of

// Rough strength of one dealt hand (before leftovers and tribute); higher is better.
//   big joker 6, small joker 5, each 2: 3, each A: 2;
//   each bomb (4+ of a rank): 4 for four cards, +3 per extra card; holding every joker: +10;
//   each 510K set (a 5, a 10 and a K): 2, +1 more when one suit makes it pure;
//   each rank 3-9 held exactly once: -1.
export function handStrength(cards, decks = 2) {
  const counts = {};
  const suited = {}; // "<rank><suit>" -> count, for pure 510K
  let score = 0;
  let jokers = 0;
  for (const c of cards) {
    if (isJoker(c)) {
      jokers += 1;
      score += c[0] === 'B' ? 6 : 5;
      continue;
    }
    counts[c[0]] = (counts[c[0]] || 0) + 1;
    suited[c.slice(0, 2)] = (suited[c.slice(0, 2)] || 0) + 1;
    if (c[0] === '2') score += 3;
    else if (c[0] === 'A') score += 2;
  }
  if (jokers === 2 * decks) score += 10;
  for (const rank of Object.keys(counts)) {
    const n = counts[rank];
    if (n >= 4) score += 4 + 3 * (n - 4);
    const value = '3456789'.indexOf(rank) >= 0 ? Number(rank) : 0;
    if (n === 1 && value && value <= LOW_SINGLE_MAX) score -= 1;
  }
  score += 2 * Math.min(counts['5'] || 0, counts.T || 0, counts.K || 0);
  for (const s of ['S', 'H', 'C', 'D']) {
    score += Math.min(suited[`5${s}`] || 0, suited[`T${s}`] || 0, suited[`K${s}`] || 0);
  }
  return score;
}

// A side's strength: the sum over its seats.
export const sideStrength = (hands, seats, decks = 2) => seats.reduce((sum, seat) => sum + handStrength(hands[seat], decks), 0);

// Pick this hand's deal. deal() -> a fresh { hands, order, leftover }; coin(p) -> true with probability p.
// Returns { cards, candidates } (candidates: how many deals were made, for tests).
export function balancedDeal({ match, deal, coin }) {
  const first = deal();
  const target = balanceTarget(match);
  if (!target) return { cards: first, candidates: 1 };
  const second = deal();
  if (!coin(balanceChance(target.deficit))) return { cards: first, candidates: 2 };
  const better = sideStrength(second.hands, target.seats, match.decks) > sideStrength(first.hands, target.seats, match.decks);
  return { cards: better ? second : first, candidates: 2 };
}
