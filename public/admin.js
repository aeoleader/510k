import { esc } from '/ui.js';

const $ = (id) => document.getElementById(id);
const ACTIONS = { card_counter_on: '开启记牌器', card_counter_off: '关闭记牌器' };
const ERRORS = { login_required: '请先在首页登录管理员账号。', admin_only: '这个账号没有管理权限。', no_user: '找不到这个用户。' };
const state = { query: '', users: [], audit: [] };

function readToken() {
  try { return localStorage.getItem('510k:accountToken'); } catch { return null; }
}

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountToken: readToken() ?? undefined, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(payload.error), { code: payload.error });
  return payload;
}

async function search() {
  try {
    const { users, audit } = await api('/api/admin/users', { query: state.query });
    state.users = users;
    state.audit = audit;
    render();
  } catch (err) {
    $('adminView').innerHTML = `<p class="page-status">${ERRORS[err.code] ?? '加载失败，请刷新重试。'}</p>`;
  }
}

function render() {
  const main = $('adminView');
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="panel-block">
        <h2>玩家</h2>
        <label class="field" for="searchInput">按用户名搜索</label>
        <input id="searchInput" maxlength="32" autocomplete="off">
        <div id="userList" class="admin-users"></div>
      </section>
      <section class="panel-block">
        <h2>最近的权限变更</h2>
        <ol id="auditList" class="admin-audit"></ol>
      </section>`;
  }
  $('userList').innerHTML = state.users.length ? `
    <table>
      <thead><tr><th>用户名</th><th>段位分</th><th>对局</th><th>注册</th><th>记牌器</th></tr></thead>
      <tbody>${state.users.map((u) => `
        <tr>
          <td><a href="/u/${encodeURIComponent(u.username)}">${esc(u.username)}</a></td>
          <td>${u.rating}</td>
          <td>${u.matches}</td>
          <td>${new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
          <td><button type="button" class="switch" role="switch" aria-checked="${u.cardCounter}" data-user="${esc(u.username)}">
            <span class="knob"></span><span class="sr">${u.cardCounter ? '已开启' : '已关闭'}</span></button></td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="muted">没有匹配的玩家。</p>';
  $('auditList').innerHTML = state.audit.length
    ? state.audit.map((a) => `<li><span class="muted">${new Date(a.at).toLocaleString('zh-CN')}</span> ${esc(a.admin)} 为 ${esc(a.target)} ${ACTIONS[a.action] ?? esc(a.action)}</li>`).join('')
    : '<li class="muted">还没有记录。</li>';
}

let debounce;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'searchInput') return;
  state.query = e.target.value;
  clearTimeout(debounce);
  debounce = setTimeout(search, 250);
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-user]');
  if (!b) return;
  b.disabled = true;
  try {
    await api('/api/admin/card-counter', { username: b.dataset.user, enabled: b.getAttribute('aria-checked') !== 'true' });
    await search();
  } catch (err) {
    alert(ERRORS[err.code] ?? '操作失败');
    b.disabled = false;
  }
});

search();
