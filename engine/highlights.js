import { sumPoints, last } from './cards.js';

const BIG_BOMB_LEVEL = 6;
const BIG_TRICK_PER_DECK = 15;
const STEAL_PER_DECK = 10;
const GIFT_MIN_POINTS = 10;

// Scan one hand's events (from game.apply) for replay markers.
// Returns [{ eventSeq, tag, seats, points }]; hand-level tags use eventSeq -1.
export function findHighlights({ events, teams, decks, sweep = false, resisted = false }) {
  const side = (seat) => (teams ? teams[seat] : seat);
  const out = [];
  const mark = (eventSeq, tag, seats, points = 0) => out.push({ eventSeq, tag, seats, points });
  let plays = [];
  const autoRun = new Map(); // seat -> whether their previous action was automatic

  for (const e of events) {
    if (e.type === 'play') {
      const prev = last(plays);
      const special = e.combo.cat >= 1;
      if (e.combo.type === 'joker_bomb' || (e.combo.type === 'bomb' && e.combo.level >= BIG_BOMB_LEVEL)) {
        mark(e.seq, 'big_bomb', [e.seat]);
      }
      if (teams && special && prev && prev.seat !== e.seat && side(prev.seat) === side(e.seat)) {
        mark(e.seq, 'team_bomb', [e.seat, prev.seat]);
      }
      plays.push({ ...e, overOpponent: Boolean(prev) && side(prev.seat) !== side(e.seat) });
    } else if (e.type === 'trick') {
      if (e.points >= BIG_TRICK_PER_DECK * decks) mark(e.seq, 'big_trick', [e.seat], e.points);
      for (const p of plays) {
        if (p.combo.cat >= 1 && p.overOpponent && p.seat === e.seat && e.points >= STEAL_PER_DECK * decks) {
          mark(p.seq, 'steal', [p.seat], e.points);
        }
        const given = sumPoints(p.cards);
        if (given >= GIFT_MIN_POINTS && side(e.seat) !== side(p.seat)) mark(p.seq, 'gift', [p.seat, e.seat], given);
      }
      plays = [];
    }
    if (e.type === 'play' || e.type === 'pass') {
      // A run of automatic actions by one seat (timed out, offline) is one moment, tagged at its start.
      if (e.auto && !autoRun.get(e.seat)) mark(e.seq, 'auto', [e.seat]);
      autoRun.set(e.seat, Boolean(e.auto));
    }
  }
  if (sweep) mark(-1, 'sweep', []);
  if (resisted) mark(-1, 'resisted', []);
  return out;
}
