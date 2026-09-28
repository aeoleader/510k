// Pits the current bot policy against the previous one in 4-player team hands.
// Every deal is played twice with the policies swapped between the teams, so the
// cards' luck cancels out. Usage: node scripts/bot-sim.js [deals=300] [seed=1]
import { fileURLToPath } from 'node:url';
import { createMatch, prepareHand } from '../engine/match.js';
import { createHandState, apply, ranking } from '../engine/game.js';
import { settleHand } from '../engine/tribute.js';
import { hints } from '../engine/hint.js';
import { botAction, botContext } from '../engine/bot.js';

// The policy before this change, kept here only as the baseline.
export function legacyBotAction({ hand, top, decks = 2, topIsTeammate = false, trickPoints = 0, opponentMinCards = Infinity }) {
  const options = hints(hand, top, decks);
  if (!top) return { type: 'play', cards: options[0].cards };
  if (topIsTeammate) return { type: 'pass' };
  const normal = options.find((o) => o.combo.cat === 0);
  if (normal) return { type: 'play', cards: normal.cards };
  const worthIt = trickPoints >= 10 || opponentMinCards <= 5;
  if (worthIt && options.length) return { type: 'play', cards: options[0].cards };
  return { type: 'pass' };
}

const MAX_ACTIONS = 5000;

// policies[team] plays every seat of that team. Returns settleHand()'s result.
export function playDeal(seed, policies) {
  const match = createMatch({ playerCount: 4, decks: 2, seed });
  const prepared = prepareHand(match);
  let state = createHandState({ hands: prepared.hands, teams: match.teams, leader: prepared.leader, decks: match.decks });
  for (let n = 0; !state.over; n++) {
    if (n > MAX_ACTIONS) throw new Error('hand did not terminate');
    const seat = state.turn;
    const action = policies[match.teams[seat]](botContext(state, seat));
    state = apply(state, { seat, ...action }).state;
  }
  return settleHand({ teams: match.teams, captured: state.captured, ranking: ranking(state), finished: state.finished });
}

// Returns { hands, wins, sweeps, lostSweeps, margin } from the candidate's point of view.
export function compare({ deals, seed = 1, candidate = botAction, baseline = legacyBotAction }) {
  const stats = { hands: 0, wins: 0, sweeps: 0, lostSweeps: 0, margin: 0 };
  for (let d = 0; d < deals; d++) {
    for (const team of [0, 1]) {
      const policies = team === 0 ? [candidate, baseline] : [baseline, candidate];
      const r = playDeal((seed * 100003 + d) >>> 0, policies);
      stats.hands += 1;
      if (r.winner === team) stats.wins += 1;
      if (r.sweep) stats[r.winner === team ? 'sweeps' : 'lostSweeps'] += 1;
      stats.margin += r.score[team] - r.score[1 - team];
    }
  }
  return stats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deals = Number(process.argv[2] ?? 300);
  const seed = Number(process.argv[3] ?? 1);
  const s = compare({ deals, seed });
  const pct = (x) => `${((100 * x) / s.hands).toFixed(1)}%`;
  console.log(`${s.hands} hands (${deals} deals x 2 seatings): new policy won ${s.wins} (${pct(s.wins)}), `
    + `avg margin ${(s.margin / s.hands).toFixed(1)} points/hand, sweeps ${s.sweeps} for / ${s.lostSweeps} against`);
}
