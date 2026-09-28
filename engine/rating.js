export const START_RATING = 60;
export const POINTS_PER_STAR = 10;
export const POINTS_PER_TIER = 30;

export const TIERS = [
  { key: 'iron', name: '黑铁', factor: 0.5 },
  { key: 'bronze', name: '青铜', factor: 0.7 },
  { key: 'silver', name: '白银', factor: 1.0 },
  { key: 'gold', name: '黄金', factor: 1.0 },
  { key: 'platinum', name: '铂金', factor: 1.2 },
  { key: 'diamond', name: '钻石', factor: 1.3 },
  { key: 'king', name: '王者', factor: 1.5 },
];

const WIN_BASE = 20;
const MARGIN_STEP_PER_DECK = 50;
const MARGIN_CAP = 10;
const SWEEP_BONUS = 2;
const LEFT_EARLY_FACTOR = 1.5;

export function rankInfo(rating) {
  const index = Math.max(0, Math.min(TIERS.length - 1, Math.floor(rating / POINTS_PER_TIER)));
  const stars = rating < 0 ? 0 : Math.floor((rating - index * POINTS_PER_TIER) / POINTS_PER_STAR);
  return { ...TIERS[index], index, stars };
}

function finalize(raw, ratingBefore, leftEarly) {
  if (raw >= 0) return raw;
  const factor = rankInfo(ratingBefore).factor * (leftEarly ? LEFT_EARLY_FACTOR : 1);
  return Math.round(raw * factor);
}

function teamDeltas(match, players) {
  const [t0, t1] = match.totals;
  let winner = null;
  if (t0 !== t1) winner = t0 > t1 ? 0 : 1;
  else if (match.sweeps[0] !== match.sweeps[1]) winner = match.sweeps[0] > match.sweeps[1] ? 0 : 1;
  const margin = Math.min(MARGIN_CAP, Math.floor(Math.abs(t0 - t1) / (MARGIN_STEP_PER_DECK * match.decks)));

  return players.map((p) => {
    if (!p.rated) return { seat: p.seat, delta: null };
    const team = match.teams[p.seat];
    let won = winner === null ? null : team === winner;
    if (p.leftEarly) won = false;
    const result = won === null ? 0 : won ? WIN_BASE + margin : -WIN_BASE - margin;
    const sweep = p.leftEarly ? 0 : SWEEP_BONUS * match.sweeps[team];
    const personal = match.heads[p.seat] - match.tails[p.seat];
    return { seat: p.seat, delta: finalize(result + sweep + personal, p.ratingBefore, p.leftEarly) };
  });
}

const placeBase = (r, n) => Math.round((WIN_BASE * (n + 1 - 2 * r)) / (n - 1));

function ffaDeltas(match, players) {
  const n = match.playerCount;
  const left = new Set(players.filter((p) => p.leftEarly).map((p) => p.seat));
  const key = (seat) => [left.has(seat) ? 1 : 0, -match.totals[seat], -match.heads[seat]];
  const order = [...Array(n).keys()].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a - b;
  });
  const base = new Map();
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && key(order[j + 1]).join() === key(order[i]).join()) j++;
    let sum = 0;
    for (let r = i + 1; r <= j + 1; r++) sum += placeBase(r, n);
    const avg = Math.round(sum / (j - i + 1));
    for (let k = i; k <= j; k++) base.set(order[k], avg);
    i = j + 1;
  }
  return players.map((p) => {
    if (!p.rated) return { seat: p.seat, delta: null };
    const raw = base.get(p.seat) + match.heads[p.seat] - match.tails[p.seat];
    return { seat: p.seat, delta: finalize(raw, p.ratingBefore, p.leftEarly) };
  });
}

// players: [{ seat, rated, ratingBefore, leftEarly }]. Returns [{ seat, delta }] (delta null if unrated).
export function computeRatingDeltas(match, players) {
  return match.teams ? teamDeltas(match, players) : ffaDeltas(match, players);
}
