// How much 发牌平衡 helps the side behind. Not part of `npm test`.
//   1. Hand strength: at several deficits, how often the favoured side's dealt strength improves and by how much.
//   2. Bots: 4-player team hands from a fixed deficit, balanceDeal off vs on over the same deals (paired),
//      and the trailing team's hand win rate in each.
// Usage: node scripts/balance-sim.js [hands=20000] [botHands=2000] [seed=1]
import { deal, seededRandom } from '../engine/cards.js';
import { createMatch, prepareHand } from '../engine/match.js';
import { createHandState, apply, ranking } from '../engine/game.js';
import { settleHand } from '../engine/tribute.js';
import { botAction, botContext } from '../engine/bot.js';
import { balancedDeal, balanceTarget, balanceChance, sideStrength } from '../engine/balance.js';

const HANDS = Number(process.argv[2] ?? 20000);
const BOT_HANDS = Number(process.argv[3] ?? 2000);
const SEED = Number(process.argv[4] ?? 1);

// A match one hand in, `deficit` points between the sides (team 1 / seat 0 behind), no tribute pending.
function matchAt({ playerCount, deficit }) {
  const m = createMatch({ playerCount, decks: playerCount >= 7 ? 3 : 2, seed: 0 });
  const totals = m.teams ? [deficit, 0] : m.totals.map((_, seat) => (seat === 0 ? 0 : deficit));
  return { ...m, handNo: 1, totals };
}

function strengthStudy() {
  console.log(`Hand strength of the favoured side, ${HANDS} hands per row (strength = sum over its seats)`);
  console.log('players deficit      p  picked 2nd  mean before  mean after  mean gain  gain when changed');
  for (const playerCount of [4, 5, 6]) {
    for (const deficit of [50, 100, 150, 200, 300, 500]) {
      const match = matchAt({ playerCount, deficit });
      const random = seededRandom(SEED * 7919 + playerCount * 1000 + deficit);
      const fresh = () => deal({ playerCount, decks: match.decks, random });
      const coin = (p) => random(1_000_000) < Math.round(p * 1_000_000);
      const target = balanceTarget(match); // null under 100: the same side is measured for comparison
      let before = 0;
      let after = 0;
      let changed = 0;
      let changedGain = 0;
      for (let i = 0; i < HANDS; i++) {
        const deals = [];
        const r = balancedDeal({ match, deal: () => { const d = fresh(); deals.push(d); return d; }, coin });
        const seats = target ? target.seats : match.teams ? match.teams.flatMap((t, seat) => (t === 1 ? [seat] : [])) : [0];
        const s0 = sideStrength(deals[0].hands, seats, match.decks);
        const s1 = sideStrength(r.cards.hands, seats, match.decks);
        before += s0;
        after += s1;
        if (r.cards !== deals[0]) {
          changed += 1;
          changedGain += s1 - s0;
        }
      }
      const p = target ? balanceChance(target.deficit) : 0;
      console.log(`${String(playerCount).padStart(7)} ${String(deficit).padStart(7)} ${p.toFixed(3).padStart(6)} `
        + `${`${((100 * changed) / HANDS).toFixed(1)}%`.padStart(11)} ${(before / HANDS).toFixed(2).padStart(12)} `
        + `${(after / HANDS).toFixed(2).padStart(11)} ${((after - before) / HANDS).toFixed(2).padStart(10)} `
        + `${(changed ? changedGain / changed : 0).toFixed(2).padStart(18)}`);
    }
  }
}

function playOut(match, cards, leader) {
  const prepared = prepareHand(match, { cards, leader });
  let state = createHandState({ hands: prepared.hands, teams: match.teams, leader: prepared.leader, decks: match.decks });
  for (let n = 0; !state.over; n++) {
    if (n > 5000) throw new Error('hand did not terminate');
    state = apply(state, { seat: state.turn, ...botAction(botContext(state, state.turn)) }).state;
  }
  return settleHand({ teams: match.teams, captured: state.captured, ranking: ranking(state), finished: state.finished });
}

function botStudy(deficit) {
  const match = matchAt({ playerCount: 4, deficit });
  const random = seededRandom(SEED * 104729 + deficit);
  const fresh = () => deal({ playerCount: 4, decks: 2, random });
  const coin = (p) => random(1_000_000) < Math.round(p * 1_000_000);
  const trailing = 1;
  const stats = { off: 0, on: 0, marginOff: 0, marginOn: 0, changed: 0 };
  for (let i = 0; i < BOT_HANDS; i++) {
    const deals = [];
    const r = balancedDeal({ match, deal: () => { const d = fresh(); deals.push(d); return d; }, coin });
    const leader = random(4); // the same leader either way
    const off = playOut(match, deals[0], leader);
    const on = r.cards === deals[0] ? off : playOut(match, r.cards, leader);
    if (r.cards !== deals[0]) stats.changed += 1;
    if (off.winner === trailing) stats.off += 1;
    if (on.winner === trailing) stats.on += 1;
    stats.marginOff += off.score[trailing] - off.score[1 - trailing];
    stats.marginOn += on.score[trailing] - on.score[1 - trailing];
  }
  const pct = (x) => `${((100 * x) / BOT_HANDS).toFixed(1)}%`;
  console.log(`deficit ${deficit}: trailing team won ${pct(stats.off)} off -> ${pct(stats.on)} on `
    + `(${stats.on - stats.off >= 0 ? '+' : ''}${(((stats.on - stats.off) * 100) / BOT_HANDS).toFixed(1)} pts), `
    + `avg margin ${(stats.marginOff / BOT_HANDS).toFixed(1)} -> ${(stats.marginOn / BOT_HANDS).toFixed(1)}, `
    + `deal changed in ${pct(stats.changed)}`);
}

strengthStudy();
if (BOT_HANDS > 0) console.log(`\nBots, 4 players 2 decks, ${BOT_HANDS} paired hands per deficit (same deals and leader, off vs on)`);
if (BOT_HANDS > 0) for (const deficit of [100, 300]) botStudy(deficit);
