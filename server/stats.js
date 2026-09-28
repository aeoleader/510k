import { HttpError } from './http.js';
import { publicAccount } from './accounts.js';

const RECENT_MATCHES = 20;
const STATS_WINDOW = 200; // matches considered for rates and partners
const BEST_PARTNER_MIN_MATCHES = 3;
const BOMB_TYPES = ['bomb', 'joker_bomb'];

const parse = (text) => JSON.parse(text);

// Outcome of a finished match for one seat: 'win' | 'loss' | 'draw'. Mirrors the rating rules:
// leaving early is a loss; team ties go to the team with more sweeps; FFA ties to more heads.
function outcomeFor(match, players, seat, sweeps) {
  const me = players.find((p) => p.seat === seat);
  if (me.left_early) return 'loss';
  const totals = parse(match.final_scores);
  if (match.mode === 'team') {
    const diff = totals[me.team] - totals[1 - me.team];
    const tie = sweeps[me.team] - sweeps[1 - me.team];
    const edge = diff || tie;
    return edge > 0 ? 'win' : edge < 0 ? 'loss' : 'draw';
  }
  const key = (p) => [p.left_early ? 0 : 1, totals[p.seat], p.heads];
  const beats = (a, b) => { const ka = key(a); const kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]; };
  const ahead = players.filter((p) => p.seat !== seat && beats(p, me) > 0).length;
  if (ahead > 0) return 'loss';
  return players.some((p) => p.seat !== seat && beats(p, me) === 0) ? 'draw' : 'win';
}

export class Stats {
  constructor(db) {
    this.db = db;
    this.q = {
      match: db.prepare('SELECT * FROM matches WHERE id = ?'),
      players: db.prepare('SELECT * FROM match_players WHERE match_id = ? ORDER BY seat'),
      hands: db.prepare('SELECT * FROM hands WHERE match_id = ? ORDER BY hand_no'),
      actions: db.prepare('SELECT * FROM hand_events WHERE hand_id = ? ORDER BY seq'),
      highlights: db.prepare('SELECT * FROM highlights WHERE hand_id = ? ORDER BY event_seq'),
      userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
      userById: db.prepare('SELECT username, rating FROM users WHERE id = ?'),
      // Every profile query covers the same window: the user's last STATS_WINDOW matches.
      myMatches: db.prepare(`SELECT m.*, mp.seat, mp.team, mp.rating_before, mp.rating_delta, mp.left_early
                             FROM match_players mp JOIN matches m ON m.id = mp.match_id
                             WHERE mp.user_id = ? ORDER BY m.id DESC LIMIT ?`),
      windowPlayers: db.prepare(`SELECT * FROM match_players WHERE match_id IN
                                   (SELECT match_id FROM match_players WHERE user_id = ? ORDER BY match_id DESC LIMIT ?)`),
      windowHands: db.prepare(`SELECT h.match_id, h.hand_no, h.result FROM hands h WHERE h.match_id IN
                                 (SELECT match_id FROM match_players WHERE user_id = ? ORDER BY match_id DESC LIMIT ?)`),
      windowBombs: db.prepare(`SELECT COUNT(*) AS n FROM hand_events e JOIN hands h ON h.id = e.hand_id
                               JOIN match_players mp ON mp.match_id = h.match_id AND mp.seat = e.seat
                               WHERE mp.user_id = ? AND e.combo_type IN (${BOMB_TYPES.map(() => '?').join(', ')})
                                 AND h.match_id IN (SELECT match_id FROM match_players WHERE user_id = ? ORDER BY match_id DESC LIMIT ?)`),
      recentHighlights: db.prepare(`SELECT h.match_id, hl.tag, hl.seats FROM highlights hl JOIN hands h ON h.id = hl.hand_id
                                    WHERE hl.tag NOT IN ('auto', 'sweep') AND h.match_id IN
                                      (SELECT match_id FROM match_players WHERE user_id = ? ORDER BY match_id DESC LIMIT ?)`),
    };
  }

  // Everything a client needs to re-run each hand with the shared engine.
  replay(matchId) {
    const match = Number.isInteger(matchId) ? this.q.match.get(matchId) : null;
    if (!match) throw new HttpError(404, 'no_match');
    const players = this.q.players.all(matchId).map((p) => ({
      seat: p.seat,
      name: p.display_name,
      isBot: Boolean(p.is_bot),
      team: p.team,
      total: p.total_score,
      heads: p.heads,
      tails: p.tails,
      ratingDelta: p.rating_delta,
      leftEarly: Boolean(p.left_early),
      account: p.user_id ? publicAccount(this.q.userById.get(p.user_id)) : null,
    }));
    const hands = this.q.hands.all(matchId).map((h) => ({
      handNo: h.hand_no,
      leader: h.leader,
      initialHands: parse(h.initial_hands),
      tribute: (({ pairs, resisted, given, returns }) => ({ pairs, resisted, given, returns }))(parse(h.tribute)),
      result: parse(h.result),
      actions: this.q.actions.all(h.id).map((a) => ({
        seat: a.seat, type: a.type, cards: a.cards ? parse(a.cards) : undefined, auto: Boolean(a.auto), elapsedMs: a.elapsed_ms,
      })),
      highlights: this.q.highlights.all(h.id).map((hl) => ({
        eventSeq: hl.event_seq, tag: hl.tag, seats: parse(hl.seats), points: hl.points,
      })),
    }));
    return {
      id: match.id,
      mode: match.mode,
      playerCount: match.player_count,
      decks: match.decks,
      startedAt: match.started_at,
      endedAt: match.ended_at,
      totals: parse(match.final_scores),
      teams: match.mode === 'team' ? players.map((p) => p.team) : null,
      players,
      hands,
    };
  }

  profile(username) {
    const user = typeof username === 'string' ? this.q.userByName.get(username) : null;
    if (!user) throw new HttpError(404, 'no_user');
    const matches = this.q.myMatches.all(user.id, STATS_WINDOW);
    const playersByMatch = groupBy(this.q.windowPlayers.all(user.id, STATS_WINDOW), (p) => p.match_id);
    const handsByMatch = groupBy(this.q.windowHands.all(user.id, STATS_WINDOW), (h) => h.match_id);
    const tagsByMatch = groupBy(this.q.recentHighlights.all(user.id, RECENT_MATCHES), (h) => h.match_id);

    let wins = 0;
    let losses = 0;
    let draws = 0;
    let hands = 0;
    let heads = 0;
    let tails = 0;
    let captured = 0;
    let sweeps = 0;
    const people = new Map(); // userId -> { name, with, withWins, against, againstWins }
    const rows = matches.map((m) => {
      const players = (playersByMatch.get(m.id) ?? []).sort((a, b) => a.seat - b.seat);
      const handRows = (handsByMatch.get(m.id) ?? []).sort((a, b) => a.hand_no - b.hand_no).map((h) => ({ ...h, result: parse(h.result) }));
      const teamSweeps = [0, 0];
      for (const h of handRows) if (h.result.sweep && h.result.winner !== null) teamSweeps[h.result.winner] += 1;
      const me = players.find((p) => p.seat === m.seat);
      const outcome = outcomeFor(m, players, m.seat, teamSweeps);
      if (outcome === 'win') wins += 1;
      else if (outcome === 'loss') losses += 1;
      else draws += 1;
      // Per-hand rates only use matches whose hands were recorded, so numerator and denominator match.
      if (handRows.length) {
        hands += handRows.length;
        for (const h of handRows) {
          captured += h.result.captured[m.seat] ?? 0;
          if (h.result.ranking[0] === m.seat) heads += 1;
          if (h.result.ranking.at(-1) === m.seat) tails += 1;
        }
        if (m.mode === 'team') sweeps += teamSweeps[me.team];
      }
      for (const other of players) {
        if (other.seat === m.seat || !other.user_id) continue;
        const entry = people.get(other.user_id) ?? { userId: other.user_id, name: other.display_name, with: 0, withWins: 0, against: 0, againstWins: 0 };
        if (m.mode === 'team' && other.team === me.team) {
          entry.with += 1;
          if (outcome === 'win') entry.withWins += 1;
        } else {
          entry.against += 1;
          if (outcome === 'win') entry.againstWins += 1;
        }
        people.set(other.user_id, entry);
      }
      return { m, players, handRows, teamSweeps, outcome };
    });

    const everyone = [...people.values()].map((p) => ({
      ...p,
      name: this.q.userById.get(p.userId)?.username ?? p.name,
      withRate: p.with ? p.withWins / p.with : null,
      againstRate: p.against ? p.againstWins / p.against : null,
    }));
    const bestPartner = everyone
      .filter((p) => p.with >= BEST_PARTNER_MIN_MATCHES)
      .sort((a, b) => b.withRate - a.withRate || b.with - a.with)[0] ?? null;
    const strip = ({ userId, withWins, againstWins, ...rest }) => rest;

    const history = [...matches].reverse()
      .filter((m) => m.rating_before !== null && m.rating_delta !== null)
      .map((m) => ({ matchId: m.id, at: m.ended_at, before: m.rating_before, after: m.rating_before + m.rating_delta }));

    const recent = rows.slice(0, RECENT_MATCHES).map(({ m, players, handRows, teamSweeps, outcome }) => {
      const side = m.mode === 'team' ? m.team : m.seat;
      const tags = (tagsByMatch.get(m.id) ?? [])
        .filter((hl) => parse(hl.seats).includes(m.seat))
        .reduce((acc, hl) => ({ ...acc, [hl.tag]: (acc[hl.tag] ?? 0) + 1 }), {});
      if (m.mode === 'team' && teamSweeps[m.team]) tags.sweep = teamSweeps[m.team];
      return {
        matchId: m.id,
        at: m.ended_at,
        mode: m.mode,
        playerCount: m.player_count,
        decks: m.decks,
        outcome,
        totals: parse(m.final_scores),
        seat: m.seat,
        team: m.team,
        ratingDelta: m.rating_delta,
        leftEarly: Boolean(m.left_early),
        hasReplay: handRows.length > 0,
        players: players.map((p) => ({ seat: p.seat, name: p.display_name, team: p.team, isBot: Boolean(p.is_bot) })),
        hands: handRows.map((h) => ({
          handNo: h.hand_no + 1, mine: h.result.score[side], best: Math.max(...h.result.score), head: h.result.ranking[0] === m.seat,
        })),
        highlights: tags,
      };
    });

    return {
      account: publicAccount(user),
      joinedAt: user.created_at,
      window: STATS_WINDOW,
      totals: {
        matches: matches.length,
        wins,
        losses,
        draws,
        winRate: matches.length ? wins / matches.length : null,
        hands,
        avgCaptured: hands ? captured / hands : null,
        headRate: hands ? heads / hands : null,
        tailRate: hands ? tails / hands : null,
        sweeps,
        bombs: this.q.windowBombs.get(user.id, ...BOMB_TYPES, user.id, STATS_WINDOW).n,
      },
      history,
      bestPartner: bestPartner ? strip(bestPartner) : null,
      teammates: everyone.filter((p) => p.with).sort((a, b) => b.with - a.with).slice(0, 5).map(strip),
      opponents: everyone.filter((p) => p.against).sort((a, b) => b.against - a.against).slice(0, 5).map(strip),
      recent,
    };
  }
}

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
