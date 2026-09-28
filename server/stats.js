import { HttpError } from './http.js';
import { publicAccount } from './accounts.js';

const RECENT_MATCHES = 20;
const STATS_WINDOW = 200; // matches considered for rates and partners
const BEST_PARTNER_MIN_MATCHES = 3;
const BOMB_TYPES = ['bomb', 'joker_bomb'];

const parse = (text) => JSON.parse(text);

// Outcome of a finished match for one seat: 'win' | 'loss' | 'draw'.
function outcomeFor(match, players, seat) {
  const totals = parse(match.final_scores);
  if (match.mode === 'team') {
    const me = players.find((p) => p.seat === seat);
    const mine = totals[me.team];
    const theirs = totals[1 - me.team];
    return mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw';
  }
  const best = Math.max(...totals);
  if (totals[seat] < best) return 'loss';
  return totals.filter((t) => t === best).length > 1 ? 'draw' : 'win';
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
      myMatches: db.prepare(`SELECT m.*, mp.seat, mp.team, mp.rating_before, mp.rating_delta, mp.left_early
                             FROM match_players mp JOIN matches m ON m.id = mp.match_id
                             WHERE mp.user_id = ? ORDER BY m.ended_at DESC, m.id DESC LIMIT ?`),
      myHands: db.prepare(`SELECT h.match_id, h.hand_no, h.result, mp.seat FROM hands h
                           JOIN match_players mp ON mp.match_id = h.match_id
                           WHERE mp.user_id = ? AND h.match_id IN (SELECT match_id FROM match_players WHERE user_id = ?
                             ORDER BY match_id DESC LIMIT ?)`),
      myBombs: db.prepare(`SELECT COUNT(*) AS n FROM hand_events e JOIN hands h ON h.id = e.hand_id
                           JOIN match_players mp ON mp.match_id = h.match_id AND mp.seat = e.seat
                           WHERE mp.user_id = ? AND e.combo_type IN (${BOMB_TYPES.map(() => '?').join(', ')})`),
      myHighlights: db.prepare(`SELECT h.match_id, hl.tag, hl.seats FROM highlights hl JOIN hands h ON h.id = hl.hand_id
                                WHERE h.match_id = ?`),
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
      tribute: parse(h.tribute),
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
    const withPlayers = matches.map((m) => ({ ...m, players: this.q.players.all(m.id) }));

    let wins = 0;
    let losses = 0;
    let draws = 0;
    let heads = 0;
    let tails = 0;
    let sweeps = 0;
    const people = new Map(); // userId -> { name, with, withWins, against, againstWins }
    for (const m of withPlayers) {
      const me = m.players.find((p) => p.seat === m.seat);
      const outcome = outcomeFor(m, m.players, m.seat);
      if (outcome === 'win') wins += 1;
      else if (outcome === 'loss') losses += 1;
      else draws += 1;
      heads += me.heads;
      tails += me.tails;
      for (const other of m.players) {
        if (other.seat === m.seat || !other.user_id) continue;
        const entry = people.get(other.user_id) ?? { userId: other.user_id, name: other.display_name, with: 0, withWins: 0, against: 0, againstWins: 0 };
        const teammate = m.mode === 'team' && other.team === me.team;
        if (teammate) {
          entry.with += 1;
          if (outcome === 'win') entry.withWins += 1;
        } else {
          entry.against += 1;
          if (outcome === 'win') entry.againstWins += 1;
        }
        people.set(other.user_id, entry);
      }
    }

    const handRows = this.q.myHands.all(user.id, user.id, STATS_WINDOW);
    let captured = 0;
    for (const row of handRows) {
      const result = parse(row.result);
      captured += result.captured[row.seat] ?? 0;
      if (!result.sweep) continue;
      const match = withPlayers.find((m) => m.id === row.match_id);
      const me = match?.players.find((p) => p.seat === row.seat);
      if (me && match.mode === 'team' && me.team === result.winner) sweeps += 1;
    }

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

    const history = [...withPlayers].reverse().map((m) => ({
      matchId: m.id,
      at: m.ended_at,
      before: m.rating_before,
      after: m.rating_before === null || m.rating_delta === null ? null : m.rating_before + m.rating_delta,
    })).filter((h) => h.after !== null);

    const recent = withPlayers.slice(0, RECENT_MATCHES).map((m) => {
      const hands = handRows.filter((h) => h.match_id === m.id)
        .sort((a, b) => a.hand_no - b.hand_no)
        .map((h) => {
          const r = parse(h.result);
          const side = m.mode === 'team' ? m.players.find((p) => p.seat === m.seat).team : m.seat;
          return { handNo: h.hand_no + 1, mine: r.score[side], best: Math.max(...r.score), head: r.ranking[0] === m.seat };
        });
      const tags = this.q.myHighlights.all(m.id)
        .filter((hl) => parse(hl.seats).includes(m.seat) || hl.tag === 'sweep')
        .reduce((acc, hl) => ({ ...acc, [hl.tag]: (acc[hl.tag] ?? 0) + 1 }), {});
      return {
        matchId: m.id,
        at: m.ended_at,
        mode: m.mode,
        playerCount: m.player_count,
        decks: m.decks,
        outcome: outcomeFor(m, m.players, m.seat),
        totals: parse(m.final_scores),
        seat: m.seat,
        team: m.team,
        ratingDelta: m.rating_delta,
        leftEarly: Boolean(m.left_early),
        players: m.players.map((p) => ({ seat: p.seat, name: p.display_name, team: p.team, isBot: Boolean(p.is_bot) })),
        hands,
        highlights: tags,
      };
    });

    const played = matches.length;
    const handCount = handRows.length;
    return {
      account: publicAccount(user),
      joinedAt: user.created_at,
      totals: {
        matches: played,
        wins,
        losses,
        draws,
        winRate: played ? wins / played : null,
        hands: handCount,
        avgCaptured: handCount ? captured / handCount : null,
        headRate: handCount ? heads / handCount : null,
        tailRate: handCount ? tails / handCount : null,
        sweeps,
        bombs: this.q.myBombs.get(user.id, ...BOMB_TYPES).n,
      },
      history,
      bestPartner: bestPartner ? strip(bestPartner) : null,
      teammates: everyone.filter((p) => p.with).sort((a, b) => b.with - a.with).slice(0, 5).map(strip),
      opponents: everyone.filter((p) => p.against).sort((a, b) => b.against - a.against).slice(0, 5).map(strip),
      recent,
    };
  }
}
