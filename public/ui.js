// Rendering helpers shared by the table, replay and profile pages.
import { isJoker } from '/engine/cards.js';
import { TIER_ICONS } from '/vendor/tier-icons.js';

export const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const RANK_LABEL = { T: '10' };
export const TYPE_LABEL = {
  single: '单张', pair: '对子', triple: '三张', triple_pair: '三带一对', straight: '顺子', pairs: '连对',
  x510k: '杂 510K', p510k: '纯 510K', bomb: '炸弹', joker_bomb: '王炸',
};
const TIER_ICON = { 1: 'shield', 2: 'shield', 3: 'medal', 4: 'award', 5: 'gem', 6: 'crown' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const initial = (name) => [...name.replace(/\(机器人\)$/, '')][0] ?? '?';
export const shortName = (name) => name.replace(/\(机器人\)$/, '');

export function cardHtml(id, { size = '', selectable = false, selected = false, bomb = false } = {}) {
  const cls = ['card'];
  if (size) cls.push(size);
  if (bomb) cls.push('bomb');
  let inner;
  if (isJoker(id)) {
    const big = id[0] === 'B';
    cls.push('joker', big ? 'big-j' : 'small-j');
    inner = `<span class="idx"><span class="r">${big ? '大王' : '小王'}</span></span><span class="big">J</span>`;
  } else {
    if (id[1] === 'H' || id[1] === 'D') cls.push('red');
    const r = RANK_LABEL[id[0]] ?? id[0];
    inner = `<span class="idx"><span class="r">${r}</span><span class="s">${SUIT_SYMBOL[id[1]]}</span></span><span class="big">${SUIT_SYMBOL[id[1]]}</span>`;
  }
  const label = isJoker(id) ? (id[0] === 'B' ? '大王' : '小王') : `${SUIT_SYMBOL[id[1]]}${RANK_LABEL[id[0]] ?? id[0]}`;
  if (selectable) {
    if (selected) cls.push('selected');
    return `<button type="button" class="${cls.join(' ')}" data-card="${id}" aria-label="${label}" aria-pressed="${selected}">${inner}</button>`;
  }
  return `<div class="${cls.join(' ')}" aria-label="${label}">${inner}</div>`;
}

// Tier badge ported from card-game: richer effects at higher tiers, stars show progress.
export function badgeHtml(account, { compact = false } = {}) {
  if (!account) return '';
  const tier = account.tier;
  const stars = account.maxStars === null
    ? (account.stars ? `<span class="tier-stars">★×${account.stars}</span>` : '')
    : `<span class="tier-stars">${'★'.repeat(account.stars)}<i>${'☆'.repeat(account.maxStars - account.stars)}</i></span>`;
  const icon = TIER_ICON[tier] ? TIER_ICONS[TIER_ICON[tier]] : '';
  return `<span class="tier-badge tier-${tier} ${compact ? 'compact' : ''}" title="${esc(`${account.tierName} ${account.stars} 星，${account.rating} 分`)}">
    ${tier >= 4 ? '<span class="tier-shine"></span>' : ''}${tier === 6 ? '<span class="tier-sparkles"><i></i><i></i><i></i><i></i></span>' : ''}
    ${icon}${esc(account.tierName)}${stars}</span>`;
}

export const fanHtml = (cards, size) => `<div class="fan">${cards.map((c) => cardHtml(c, { size })).join('')}</div>`;
