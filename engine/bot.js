import { hints } from './hint.js';
import { identify, beats } from './combos.js';
import { valueOf, isJoker, sumPoints, compareCards } from './cards.js';

// A trick worth this many points justifies a 510K or bomb.
const SPECIAL_WORTH_POINTS = 15;
// An opponent this close to going out justifies a 510K or bomb.
const OPPONENT_DANGER_CARDS = 5;
// An opponent this close to going out must be stopped: beat their plays even at a cost.
const OPPONENT_OUT_CARDS = 3;
// With this few cards left, breaking a bomb or 510K for a normal play is fine.
const NEARLY_EMPTY = 4;
// A: cards of this value and up (A, 2, jokers) are control cards worth keeping.
const HIGH_VALUE = 14;

// Everything the policy needs from a hand in play, seen from `seat`.
export function botContext(state, seat) {
  const { hands, teams, trick, decks } = state;
  const side = (s) => (teams ? teams[s] : s);
  const isOpponent = (i) => side(i) !== side(seat);
  const minCards = (keep) => Math.min(...hands.flatMap((h, i) => (h.length && i !== seat && keep(i) ? [h.length] : [])));
  let opponentsToAct = 0;
  if (trick) {
    const n = hands.length;
    for (let i = (seat + 1) % n; i !== trick.topSeat && i !== seat; i = (i + 1) % n) {
      if (hands[i].length && isOpponent(i)) opponentsToAct += 1;
    }
  }
  return {
    hand: hands[seat],
    top: trick?.top ?? null,
    decks,
    topIsTeammate: Boolean(teams && trick && trick.topSeat !== seat && side(trick.topSeat) === side(seat)),
    trickPoints: trick ? sumPoints(trick.cards) : 0,
    opponentMinCards: minCards(isOpponent),
    teammateMinCards: minCards((i) => !isOpponent(i)),
    opponentsToAct,
  };
}

function countByValue(hand) {
  const counts = new Map();
  for (const c of hand) if (!isJoker(c)) counts.set(valueOf(c), (counts.get(valueOf(c)) || 0) + 1);
  return counts;
}

const count510k = (get) => Math.min(get(5), get(10), get(13));

// What a play costs the rest of the hand.
function describe(counts, cards, combo) {
  const used = countByValue(cards);
  let breaksBomb = 0;
  let splits = 0;
  for (const [v, k] of used) {
    const have = counts.get(v);
    if (have >= 4 && k < have) breaksBomb += 1;
    else if (k < have) splits += 1;
  }
  const before = count510k((v) => counts.get(v) ?? 0);
  const after = count510k((v) => (counts.get(v) ?? 0) - (used.get(v) ?? 0));
  const breaks510k = combo.cat === 0 && after < before;
  const high = cards.filter((c) => valueOf(c) >= HIGH_VALUE).length;
  return { breaksBomb, breaks510k, splits, high, points: sumPoints(cards) };
}

// hints() pairs each triple with one pair; add every pair choice so points can stay home.
function triplePairVariants(hand, top, decks) {
  if (top && top.type !== 'triple_pair') return [];
  const groups = new Map();
  for (const c of [...hand].sort(compareCards)) {
    if (isJoker(c)) continue;
    if (!groups.has(valueOf(c))) groups.set(valueOf(c), []);
    groups.get(valueOf(c)).push(c);
  }
  const out = [];
  for (const [t, triple] of groups) {
    if (triple.length < 3) continue;
    for (const [p, pair] of groups) {
      if (p === t || pair.length < 2) continue;
      const cards = [...triple.slice(0, 3), ...pair.slice(0, 2)];
      const combo = identify(cards, decks);
      if (combo && beats(combo, top)) out.push({ cards, combo });
    }
  }
  return out;
}

function candidates(hand, top, decks) {
  const seen = new Set();
  const counts = countByValue(hand);
  return [...hints(hand, top, decks), ...triplePairVariants(hand, top, decks)].flatMap((o) => {
    const key = [...o.cards].sort().join();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...o, ...describe(counts, o.cards, o.combo) }];
  });
}

const play = (option) => ({ type: 'play', cards: option.cards });
const PASS = { type: 'pass' };
const pickBest = (list, score) => list.reduce((best, o) => (best === null || score(o) < score(best) ? o : best), null);

// Lower is better: keep points, control cards and groups; dump low cards, more at once.
// Against an opponent about to go out, avoid a lead they can go out on.
function leadScore(o, ctx) {
  const { opponentMinCards, teammateMinCards, hand } = ctx;
  const { combo } = o;
  let s = o.points * 3 + o.high * 25 + o.splits * 15 - o.cards.length * 2 + combo.value;
  if (hand.length > NEARLY_EMPTY) s += o.breaksBomb * 1000 + (o.breaks510k ? 400 : 0);
  const simple = combo.type === 'single' || combo.type === 'pair' || combo.type === 'triple';
  if (simple && o.cards.length <= opponentMinCards && opponentMinCards <= OPPONENT_OUT_CARDS) {
    // They could go out on it: lead something else, or at least the highest.
    s += 300 - 3 * combo.value;
  } else if (combo.type === 'single' && teammateMinCards === 1 && opponentMinCards > OPPONENT_OUT_CARDS) {
    s -= 30; // a low single lets the teammate out
  }
  return s;
}

function followScore(o) {
  return o.points * 3 + o.high * 10 + o.splits * 6 + (o.breaks510k ? 400 : 0) + o.breaksBomb * 1000 + o.combo.value;
}

// Weakest special first, preferring one that leaves other specials whole.
const specialScore = (o) => o.breaksBomb * 1000 + o.combo.cat * 100 + o.combo.level * 10 + o.combo.sub;

// Bot / auto-play policy shared by bots, absent players and turn timeouts.
// Pure and deterministic. ctx: see botContext().
export function botAction(ctx) {
  const {
    hand, top, decks = 2, topIsTeammate = false, trickPoints = 0,
    opponentMinCards = Infinity, opponentsToAct = 0,
  } = ctx;
  const full = { ...ctx, decks, opponentMinCards, teammateMinCards: ctx.teammateMinCards ?? Infinity };
  const options = candidates(hand, top, decks);
  if (!options.length) return PASS;

  // Endgame: the whole hand goes in one play.
  const out = options.find((o) => o.cards.length === hand.length);
  if (out) return play(out);

  const normals = options.filter((o) => o.combo.cat === 0);
  const specials = options.filter((o) => o.combo.cat > 0);
  const nearlyEmpty = hand.length <= NEARLY_EMPTY;
  const danger = opponentMinCards <= OPPONENT_OUT_CARDS;

  if (!top) {
    if (normals.length) return play(pickBest(normals, (o) => leadScore(o, full)));
    return play(pickBest(specials, specialScore));
  }

  if (topIsTeammate) {
    // Feed points onto a trick the team is sure to win (no opponent left to answer);
    // never bomb over a teammate. (A normal play can't beat a special or an A+ top, so
    // "the top is strong" never leaves room to feed.)
    const feeds = normals.filter((o) => o.points > 0 && !o.breaksBomb && !o.breaks510k && !o.high);
    if (opponentsToAct === 0 && feeds.length) return play(pickBest(feeds, (o) => -o.points * 10 + o.splits * 6 + o.combo.value));
    return PASS;
  }

  const affordable = normals.filter((o) => nearlyEmpty || danger || (!o.breaksBomb && !o.breaks510k));
  if (affordable.length) return play(pickBest(affordable, followScore));

  const canFinish = (o) => {
    const rest = hand.filter((c) => !o.cards.includes(c));
    return rest.length <= 3 || identify(rest, decks) !== null;
  };
  const worthIt = trickPoints >= SPECIAL_WORTH_POINTS || opponentMinCards <= OPPONENT_DANGER_CARDS;
  const usable = specials.filter((o) => worthIt || canFinish(o));
  if (usable.length) return play(pickBest(usable, specialScore));
  return PASS;
}
