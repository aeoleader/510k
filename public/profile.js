import { esc, badgeHtml, initial, shortName } from '/ui.js';
import { TIERS, POINTS_PER_TIER } from '/engine/rating.js';

const TAGS = { big_bomb: '大炸', big_trick: '大墩', steal: '截胡', gift: '送分', team_bomb: '误炸队友', auto: '托管', sweep: '完胜', resisted: '抗贡' };
const OUTCOME = { win: '胜', loss: '负', draw: '平' };
const $ = (id) => document.getElementById(id);
const pct = (x) => (x === null ? '暂无' : `${Math.round(x * 100)}%`);
const fixed = (x) => (x === null ? '暂无' : x.toFixed(1));
const date = (t) => new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
const dateTime = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const FILTERS = [['all', '全部'], ['win', '胜'], ['loss', '负']];

let targetName = null;
// State for the paginated 历史对局 section (independent of the profile snapshot's own totals).
const history = { filter: 'all', items: [], nextBefore: null, total: null, loading: false };

function readToken() {
  try { return localStorage.getItem('510k:accountToken'); } catch { return null; }
}

async function load() {
  let name;
  try {
    name = decodeURIComponent(location.pathname.match(/^\/u\/([^/]+)$/)?.[1] ?? 'me');
  } catch {
    $('status').textContent = '玩家地址不正确。';
    return;
  }
  targetName = name;
  const res = await fetch('/api/users/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountToken: readToken() ?? undefined, username: name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('status').textContent = data.error === 'login_required' ? '登录后才能查看战绩，请先回到首页登录。' : data.error === 'no_user' ? '找不到这个玩家。' : '加载失败，请刷新重试。';
    return;
  }
  render(data);
  loadHistory({ reset: true });
}

// Fetches one page of /api/users/matches for the current filter and renders it.
async function loadHistory({ reset = false } = {}) {
  if (history.loading) return;
  history.loading = true;
  renderHistoryControls();
  const res = await fetch('/api/users/matches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountToken: readToken() ?? undefined,
      username: targetName,
      outcome: history.filter === 'all' ? undefined : history.filter,
      before: reset ? undefined : history.nextBefore ?? undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  history.loading = false;
  if (!res.ok) {
    renderHistoryControls();
    return;
  }
  history.items = reset ? data.matches : [...history.items, ...data.matches];
  history.nextBefore = data.nextBefore;
  history.total = data.total;
  renderHistory();
}

function render(d) {
  const t = d.totals;
  const a = d.account;
  document.title = `${a.username} 的战绩 - 五十K`;
  const tiles = [
    ['轮数', t.matches],
    ['胜率', pct(t.winRate)],
    ['每局平均捡分', fixed(t.avgCaptured)],
    ['头游率', pct(t.headRate)],
    ['末游率', pct(t.tailRate)],
    ['完胜', t.sweeps],
    ['炸弹', t.bombs],
  ];
  $('profileView').innerHTML = `
    <section class="profile-hero">
      <span class="avatar" style="--size:64px">${esc(initial(a.username))}</span>
      <div class="hero-text">
        <h1>${esc(a.username)}</h1>
        <div class="hero-sub">${badgeHtml(a)}<span>${t.wins} 胜 ${t.losses} 负${t.draws ? ` ${t.draws} 平` : ''}</span></div>
      </div>
      <div class="hero-figure"><span class="label">段位分</span><span class="value">${a.rating}</span></div>
    </section>
    ${t.matches >= d.window ? `<p class="muted">统计范围：最近 ${d.window} 轮</p>` : ''}
    <section class="stat-tiles">${tiles.map(([label, value]) => `<div class="stat-tile"><span class="label">${label}</span><span class="value">${value}</span></div>`).join('')}</section>
    <section class="panel-block">
      <h2>段位分变化</h2>
      ${ratingChart(d.history, a.rating)}
    </section>
    <section class="people">
      ${peopleBlock('最佳搭档', d.bestPartner ? [d.bestPartner] : [], 'with', '一起打满 3 轮后显示')}
      ${peopleBlock('常见队友', d.teammates, 'with', '还没有和注册玩家组过队')}
      ${peopleBlock('常见对手', d.opponents, 'against', '还没有遇到注册玩家')}
    </section>
    <section class="panel-block history-block">
      <div class="history-head">
        <h2>历史对局<span class="muted" id="historyCount"></span></h2>
        <span class="segmented" role="group" aria-label="按结果筛选" id="historyFilter">
          ${FILTERS.map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${key === history.filter}">${label}</button>`).join('')}
        </span>
      </div>
      <div class="recent" id="historyRows"></div>
      <p class="muted" id="historyEmpty" hidden>还没有符合条件的对局。</p>
      <button type="button" class="btn btn-ghost btn-block" id="historyMore" hidden>加载更多</button>
    </section>`;
  setupChart(d.history);
}

function renderHistory() {
  const rows = $('historyRows');
  if (rows) rows.innerHTML = history.items.map(recentRow).join('');
  const empty = $('historyEmpty');
  if (empty) empty.hidden = history.items.length > 0;
  const count = $('historyCount');
  if (count) count.textContent = history.total === null ? '' : `，共 ${history.total} 轮`;
  renderHistoryControls();
}

function renderHistoryControls() {
  const more = $('historyMore');
  if (more) {
    more.hidden = !history.nextBefore && !history.loading;
    more.disabled = history.loading;
    more.textContent = history.loading ? '加载中…' : '加载更多';
  }
  for (const b of document.querySelectorAll('#historyFilter [data-filter]')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === history.filter));
  }
}

document.addEventListener('click', (e) => {
  const filterBtn = e.target.closest('#historyFilter [data-filter]');
  if (filterBtn) {
    if (filterBtn.dataset.filter === history.filter) return;
    history.filter = filterBtn.dataset.filter;
    history.items = [];
    history.nextBefore = null;
    history.total = null;
    renderHistoryControls();
    loadHistory({ reset: true });
    return;
  }
  if (e.target.closest('#historyMore')) loadHistory({ reset: false });
});

function peopleBlock(title, list, key, empty) {
  const rows = list.map((p) => {
    const n = key === 'with' ? p.with : p.against;
    const rate = key === 'with' ? p.withRate : p.againstRate;
    return `<li><a href="/u/${encodeURIComponent(p.name)}">${esc(p.name)}</a><span>${n} 轮，胜率 ${pct(rate)}</span></li>`;
  }).join('');
  return `<div class="people-block"><h2>${title}</h2>${rows ? `<ul>${rows}</ul>` : `<p class="muted">${empty}</p>`}</div>`;
}

function recentRow(m) {
  const sides = m.mode === 'team' ? [0, 1] : m.players.map((p) => p.seat);
  const mySide = m.mode === 'team' ? m.team : m.seat;
  const label = (side) => (m.mode === 'team'
    ? m.players.filter((p) => p.team === side).map((p) => esc(shortName(p.name))).join('、')
    : esc(shortName(m.players[side].name)));
  const score = sides.map((side) => `<span class="${side === mySide ? 'mine' : ''}">${m.totals[side]}</span>`).join(' : ');
  const tags = Object.entries(m.highlights).map(([tag, n]) => `<span class="tag tag-${tag}">${TAGS[tag] ?? tag}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
  const hands = m.hands.map((h) => `<a class="hand-chip ${h.mine === h.best ? 'top' : ''}" href="/replay/${m.matchId}?hand=${h.handNo}" title="第 ${h.handNo} 局${h.head ? '，头游' : ''}">${h.mine}${h.head ? '<i>头</i>' : ''}</a>`).join('');
  const delta = m.ratingDelta === null ? '' : `<span class="delta ${m.ratingDelta >= 0 ? 'up' : 'down'}">${m.ratingDelta >= 0 ? '+' : ''}${m.ratingDelta}</span>`;
  return `
    <details class="recent-row">
      <summary>
        <span class="outcome outcome-${m.outcome}">${OUTCOME[m.outcome]}</span>
        <span class="when">${dateTime(m.at)}</span>
        <span class="score">${score}</span>
        <span class="mode">${m.playerCount} 人${m.mode === 'team' ? '组队' : '各自为战'}${m.leftEarly ? '，中途离开' : ''}</span>
        ${delta}
      </summary>
      <div class="recent-detail">
        <div class="muted">${sides.map((side) => `${label(side)}`).join(' 对 ')}</div>
        <div class="hand-chips" aria-label="每局本方得分">${hands}</div>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        ${m.hasReplay ? `<a class="btn btn-sm" href="/replay/${m.matchId}">看回放</a>` : '<span class="muted">这一轮没有回放记录</span>'}
      </div>
    </details>`;
}

// ---- rating chart: one series, tier boundaries as recessive gridlines, hover crosshair ----------

const CHART = { w: 720, h: 240, left: 56, right: 44, top: 16, bottom: 28 };

function ratingChart(history, current) {
  if (history.length < 1) return '<p class="muted">打完一轮登录局后，这里会显示段位分的变化。</p>';
  const points = [{ i: 0, rating: history[0].before, at: null }, ...history.map((h, i) => ({ i: i + 1, rating: h.after, at: h.at, delta: h.after - h.before }))];
  const values = points.map((p) => p.rating);
  const lo = Math.floor((Math.min(...values) - 5) / POINTS_PER_TIER) * POINTS_PER_TIER;
  const hi = Math.ceil((Math.max(...values) + 5) / POINTS_PER_TIER) * POINTS_PER_TIER;
  const x = (i) => CHART.left + (i / Math.max(1, points.length - 1)) * (CHART.w - CHART.left - CHART.right);
  const y = (v) => CHART.top + (1 - (v - lo) / Math.max(1, hi - lo)) * (CHART.h - CHART.top - CHART.bottom);
  const grid = [];
  for (let v = lo; v <= hi; v += POINTS_PER_TIER) {
    const tier = TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.floor(v / POINTS_PER_TIER)))];
    grid.push(`<line class="grid" x1="${CHART.left}" x2="${CHART.w - CHART.right}" y1="${y(v)}" y2="${y(v)}"/>`);
    grid.push(`<text class="axis" x="${CHART.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    if (v < hi) grid.push(`<text class="axis tier" x="${CHART.left + 6}" y="${y(v) - 6}">${tier.name}</text>`);
  }
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.rating).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const table = history.map((h, i) => `<tr><td>第 ${i + 1} 轮</td><td>${date(h.at)}</td><td>${h.before}</td><td>${h.after}</td><td>${h.after - h.before >= 0 ? '+' : ''}${h.after - h.before}</td></tr>`).join('');
  return `
    <figure class="chart" aria-label="段位分随对局的变化，当前 ${current} 分">
      <svg id="ratingSvg" viewBox="0 0 ${CHART.w} ${CHART.h}" role="img">
        ${grid.join('')}
        <path class="area" d="${path} L${x(last.i)},${CHART.h - CHART.bottom} L${x(0)},${CHART.h - CHART.bottom} Z"/>
        <path class="line" d="${path}"/>
        <circle class="dot" cx="${x(last.i)}" cy="${y(last.rating)}" r="5"/>
        <text class="end-label" x="${x(last.i) + 10}" y="${y(last.rating) + 4}">${last.rating}</text>
        <line class="crosshair" id="crosshair" y1="${CHART.top}" y2="${CHART.h - CHART.bottom}" x1="-10" x2="-10"/>
        <circle class="dot hover" id="hoverDot" r="5" cx="-10" cy="-10"/>
        <rect id="hitArea" x="${CHART.left}" y="0" width="${CHART.w - CHART.left - CHART.right}" height="${CHART.h}" fill="transparent"/>
      </svg>
      <div class="chart-tip" id="chartTip" hidden></div>
      <figcaption class="muted">横轴为已打完的登录局，按时间先后排列</figcaption>
    </figure>
    <details class="table-view"><summary>表格查看</summary>
      <table><thead><tr><th>轮次</th><th>日期</th><th>之前</th><th>之后</th><th>变化</th></tr></thead><tbody>${table}</tbody></table>
    </details>`;
}

function setupChart(history) {
  const svg = $('ratingSvg');
  if (!svg || !history.length) return;
  const points = [{ i: 0, rating: history[0].before }, ...history.map((h, i) => ({ i: i + 1, rating: h.after, at: h.at, delta: h.after - h.before }))];
  const lo = Math.floor((Math.min(...points.map((p) => p.rating)) - 5) / POINTS_PER_TIER) * POINTS_PER_TIER;
  const hi = Math.ceil((Math.max(...points.map((p) => p.rating)) + 5) / POINTS_PER_TIER) * POINTS_PER_TIER;
  const x = (i) => CHART.left + (i / Math.max(1, points.length - 1)) * (CHART.w - CHART.left - CHART.right);
  const y = (v) => CHART.top + (1 - (v - lo) / Math.max(1, hi - lo)) * (CHART.h - CHART.top - CHART.bottom);
  const tip = $('chartTip');
  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * CHART.w;
    const nearest = points.reduce((best, p) => (Math.abs(x(p.i) - vx) < Math.abs(x(best.i) - vx) ? p : best));
    $('crosshair').setAttribute('x1', x(nearest.i));
    $('crosshair').setAttribute('x2', x(nearest.i));
    $('hoverDot').setAttribute('cx', x(nearest.i));
    $('hoverDot').setAttribute('cy', y(nearest.rating));
    tip.hidden = false;
    tip.innerHTML = nearest.i === 0
      ? `<b>${nearest.rating}</b> 分<br>第 1 轮之前`
      : `<b>${nearest.rating}</b> 分（${nearest.delta >= 0 ? '+' : ''}${nearest.delta}）<br>第 ${nearest.i} 轮，${date(nearest.at)}`;
    const left = (x(nearest.i) / CHART.w) * box.width;
    tip.style.left = `${Math.min(box.width - 150, Math.max(0, left - 60))}px`;
  };
  const hide = () => {
    tip.hidden = true;
    $('crosshair').setAttribute('x1', -10);
    $('crosshair').setAttribute('x2', -10);
    $('hoverDot').setAttribute('cx', -10);
  };
  const hit = $('hitArea');
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
}

load();
