# Dealing mode, visible tribute, no-timer, pause, and hand review — design

Approved by the user on 2026-09-28. Repo conventions: Node 22, zero dependencies, ES modules,
pure engine in `engine/` shared with the browser, `server/room.js` sequences phases and timers,
`public/app.js` renders views from `room.viewFor()`. Browser code must stay compatible with
Chromium 80 / Safari 13.4 (no `Array#at`, `structuredClone`, `??=`, `inset:` shorthand; use
`last()` / `clone()` from `engine/cards.js`). Tests use `node:test` (`npm test`); keep all existing
tests passing and add tests for every server rule below.

## 1. Tribute and return are visible and slower

- New phase `tribute` between the deal and `returning` (only when some tribute was given, i.e.
  `prepared.tribute.given.length > 0`). It lasts `delays.tributeMs` (default 5000). The view
  exposes the tribute cards to **everyone**: `tribute.given` already has `{from, to, card}`.
  Client: each tribute card animates from the giver's seat to the receiver's seat, and a caption
  panel lists "阿福 → 五哥 上贡 大王" lines (use the existing card rendering). Resisted tribute
  (`抗贡`) shows a clear "抗贡：本局免贡" stamp for the same duration.
- `returning` deadline: `delays.returnMs` default raised to 30000.
  The receiver's return dialog is more prominent: big countdown, the tributer's card shown
  ("阿福 上贡给你 大王"), selected card preview, confirm button. Everyone else sees who is
  still choosing.
- After all returns are in: phase `return_reveal` for `delays.returnRevealMs` (default 3000)
  showing "五哥 还贡 阿福 ♦4" to **everyone** (returned cards become public in this phase; during
  `returning` a return card stays visible only to the two parties, as today). Then `playing`.
- Bots/auto seats in `tribute`/`return_reveal` just wait for the timer.

## 2. 不计时 turn-time option

- `TURN_SECONDS_CHOICES` gains `0`, meaning no limit (label "不计时"). `null` stays "server default".
- With 0: online humans never time out — no deadline, no auto-play timer on their turn, and no
  deadline in `returning` for online receivers (auto seats still return after `botMs`).
  Offline / left-early seats are still auto-played exactly as now.
- The view reports `turnSeconds: 0`; the UI hides the countdown ring/timer when there is no deadline.

## 3. Pause (host only)

- `POST /api/rooms/pause` and `/api/rooms/resume` (same auth/shape as other host actions; add to
  rate limiting like the others). Allowed in phases `dealing`, `tribute`, `returning`,
  `return_reveal`, `playing`, `hand_over`. Pausing records `pausedRemaining = deadline - now` (or the
  remaining ms of the pending timer when there is no visible deadline), clears the timer and the
  deadline; the room keeps `paused: true`. Resume restores the deadline as `now + pausedRemaining`
  and re-schedules. Dealing progress (section 4) must freeze too: the deal clock is shifted by the
  paused duration so no cards are revealed while paused.
- While paused, every player action (play, pass, return, claim black 3, ready) is rejected with
  409 `paused`. Host change (host leaves) keeps the pause; the new host can resume.
- View: `paused: boolean`. Client: full-table overlay "房主已暂停", host sees "继续游戏"; host has a
  pause button in the top bar during the allowed phases.

## 4. Dealing mode (host lobby toggle, default off) with the 亮黑3 race

- Lobby setting `dealMode: boolean` (host only, lobby only, like decks/turn time; POST
  `/api/rooms/deal-mode` `{ on: boolean }`). Shown in the lobby settings for everyone.
- Engine: `deal()` must also expose the dealt order before sorting (e.g. `order: string[][]`, each
  seat's cards in the order they were dealt; round r gives every seat its r-th card).
  `prepareHand(match, { leader } = {})` accepts an optional leader override; the leftover cards go
  to whichever leader is used. Existing behaviour without the override is unchanged.
- When dealMode is on, **every** hand starts in phase `dealing`:
  - `dealStartedAt` and `delays.dealRoundMs` (default 120) define how many rounds have been revealed:
    `rounds = floor((now - dealStartedAt) / dealRoundMs)`, capped at cards per seat. The view gives
    each player only their own first `rounds` cards (in dealt order) plus `dealRounds` and
    `dealTotalRounds`, `dealStartedAt`, `dealRoundMs`, `serverNow` so the client animates cards
    flying in between pushes (no server push per card is needed; push on claim and at end).
  - Black 3 = spade 3 only (card ids starting `3S`). A player may `POST /api/rooms/claim-three`
    once a spade 3 has been revealed to them (its index in their dealt order < rounds). First valid
    claim wins; later claims get 409 `already_claimed`; a claim without a revealed spade 3 gets 409
    `no_black_three`. Dealing continues after a claim. Everyone sees "X 亮黑3！" (stamp effect).
  - Bots holding a spade 3 claim after a random 1000–2500 ms from the moment it was revealed to them.
    Offline humans do not claim.
  - Deal end = all rounds revealed. Then a grace of `delays.claimGraceMs` (default 3000) if nobody
    has claimed yet. If still nobody: random seat among spade-3 holders; if no seat holds one (all in
    leftover), a random seat.
  - Then the client plays a short sorting animation (cards slide from dealt order into sorted order,
    ~600 ms) — purely client side.
  - The winner is the hand's leader: `prepareHand(match, { leader: winner })`, then the normal
    tribute flow (section 1) and play. The previous head no longer leads when dealMode is on.
- dealMode off: current behaviour (random first leader, then previous head, no dealing phase).
- Replays: record the leader as now; also record `claimedBy` in the hand record's tribute/meta so the
  replay can say who showed the black 3. Replays of old matches must still load.

## 5. Review pause after each hand (复盘)

- `delays.nextHandMs` default raised to 30000.
- New `POST /api/rooms/ready`: a player in `hand_over` marks themselves ready. The next hand starts
  when every online, not-left human has marked ready, or at the deadline, or when the host presses
  "马上开始" (existing next-hand action). View: `ready: seat[]`.
- Result dialog becomes a review: per player — captured points this hand, finish place, and the
  cards they still held at the end (face up; empty for players who went out); team totals as now;
  a "准备好了" button (shows ✓ and "等待其他人 x/y" once pressed); and a "收起" toggle that collapses
  the dialog to a small bar so players can look at the table (last trick stays visible), with a
  button to reopen it.

## Layout

Everything must fit the existing portrait and landscape (`html.landscape`, `html.rotated`) layouts
with no overlap and no page scroll; landscape uses the compact variants of new dialogs.
