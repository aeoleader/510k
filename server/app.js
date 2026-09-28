import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { HttpError, sendJson, sendError, readJson } from './http.js';
import {
  parseCards, parseCard, parseName, parseCode, parseDecks, parseToken, parseTurnSeconds, parseDealMode, parseBeforeId, parseOutcomeFilter,
} from './validate.js';
import { publicAccount } from './accounts.js';
import { RateLimiter } from './limiter.js';
import { Stats } from './stats.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CONNECTIONS = 4000;
// HTML pages only load our own scripts; inline style attributes are used for layout variables.
const HTML_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// Serve `urlPath` from `root`, refusing anything that resolves outside it.
function serveFile(res, root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return sendError(res, 400, 'bad_path');
  }
  const file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) return sendError(res, 403, 'forbidden');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, 404, 'not_found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(path.extname(file) === '.html' ? HTML_HEADERS : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
}

function roomPayload(room, player) {
  return { code: room.code, token: player.token, playerId: player.id };
}

// accounts: an Accounts instance, or null to run guest-only (no login, no ratings).
// admins: usernames (any case) allowed into /admin.
// rateLimits: optional { login, register, rooms } overrides of { limit, windowMs } (tests use looser limits).
export function createApp({ publicDir, engineDir, delays, timers, now, accounts = null, admins = [], rateLimits = {} } = {}) {
  // Admins are resolved to account ids once, at startup: a listed name that nobody has registered yet
  // grants nothing (otherwise whoever registers it first would become admin).
  const adminIds = new Set();
  for (const name of admins) {
    const user = accounts?.q.byName.get(name);
    if (user && user.username === name) adminIds.add(user.id);
    else console.warn(`ADMIN_USERS: no account named "${name}"; it gets no admin rights`);
  }
  const hub = new Hub({ delays, timers, now, accounts });
  const stats = accounts ? new Stats(accounts.db) : null;
  // Password guessing and room spam are bounded per client IP (and per username for logins).
  const limitSpec = {
    login: { limit: 10, windowMs: 60_000 },
    register: { limit: 5, windowMs: 10 * 60_000 },
    rooms: { limit: 30, windowMs: 10 * 60_000 },
    reads: { limit: 60, windowMs: 60_000 }, // replays and profiles run many queries each
    pause: { limit: 6, windowMs: 60_000 }, // per player, pausing and resuming counted separately
    ...rateLimits,
  };
  const limits = Object.fromEntries(Object.entries(limitSpec).map(([k, spec]) => [k, new RateLimiter({ ...spec, now })]));
  const publicRoot = path.resolve(publicDir);
  const engineRoot = path.resolve(engineDir);

  // POST handlers: body -> JSON payload. Auth'd handlers receive { room, player, body }.
  const requireAccounts = () => {
    if (!accounts) throw new HttpError(503, 'accounts_disabled');
    return accounts;
  };
  const userFor = (body) => (accounts ? accounts.userForToken(body.accountToken) : null);
  const displayName = (body, user) => (user ? user.username : parseName(body.name));
  const requireAdmin = (body) => {
    requireAccounts();
    const user = userFor(body);
    if (!user) throw new HttpError(401, 'login_required');
    if (!adminIds.has(user.id)) throw new HttpError(403, 'admin_only');
    return user;
  };

  const open = {
    '/api/auth/register': async (body, ip) => {
      limits.register.hit(ip);
      const { token, user } = await requireAccounts().register(body.username, body.password);
      return { accountToken: token, account: publicAccount(user) };
    },
    '/api/auth/login': async (body, ip) => {
      limits.login.hit(ip);
      limits.login.hit(`${ip}|${String(body.username ?? '').toLowerCase().slice(0, 32)}`);
      const { token, user } = await requireAccounts().login(body.username, body.password);
      return { accountToken: token, account: publicAccount(user) };
    },
    '/api/auth/me': (body) => {
      const user = requireAccounts().userForToken(body.accountToken);
      if (!user) throw new HttpError(401, 'session_expired');
      return { account: publicAccount(user), isAdmin: adminIds.has(user.id) };
    },
    '/api/auth/logout': (body) => {
      requireAccounts().logout(body.accountToken);
      return { ok: true };
    },
    // Replays and profiles are for signed-in players (spec 5.2).
    '/api/matches/replay': (body, ip) => {
      requireAccounts();
      limits.reads.hit(ip);
      if (!userFor(body)) throw new HttpError(401, 'login_required');
      return stats.replay(Number(body.matchId));
    },
    '/api/users/profile': (body, ip) => {
      requireAccounts();
      limits.reads.hit(ip);
      const me = userFor(body);
      if (!me) throw new HttpError(401, 'login_required');
      const name = body.username === undefined || body.username === 'me' ? me.username : String(body.username);
      return stats.profile(name);
    },
    // Full (paginated) match history for the profile page's 历史对局 section.
    '/api/users/matches': (body, ip) => {
      requireAccounts();
      limits.reads.hit(ip);
      const me = userFor(body);
      if (!me) throw new HttpError(401, 'login_required');
      const name = body.username === undefined || body.username === 'me' ? me.username : String(body.username);
      return stats.matches(name, { before: parseBeforeId(body.before), outcome: parseOutcomeFilter(body.outcome) });
    },
    '/api/admin/users': (body) => {
      requireAdmin(body);
      return { users: accounts.searchUsers(body.query), audit: accounts.auditLog() };
    },
    '/api/admin/card-counter': (body) => {
      const admin = requireAdmin(body);
      const user = accounts.setCardCounter(admin, body.username, body.enabled === true);
      hub.refreshUser(user.id);
      return { username: user.username, cardCounter: Boolean(user.card_counter) };
    },
    '/api/rooms/create': (body, ip) => {
      limits.rooms.hit(ip);
      const user = userFor(body);
      const { room, player } = hub.createRoom(displayName(body, user), user, ip);
      return roomPayload(room, player);
    },
    '/api/rooms/join': (body, ip) => {
      const code = parseCode(body.code);
      const existing = body.token ? hub.getRoom(code).findByToken(parseToken(body.token)) : null;
      if (existing) return roomPayload(hub.getRoom(code), hub.rejoin(hub.getRoom(code), existing));
      limits.rooms.hit(ip);
      const user = userFor(body);
      const { room, player } = hub.joinRoom(code, displayName(body, user), user);
      return roomPayload(room, player);
    },
  };
  const authed = {
    '/api/rooms/leave': ({ room, player }) => hub.leave(room, player),
    '/api/rooms/add-bot': ({ room, player }) => { room.addBot(player.id); },
    '/api/rooms/remove-player': ({ room, player, body }) => hub.kick(room, player.id, String(body.playerId ?? '')),
    '/api/rooms/set-decks': ({ room, player, body }) => room.setDecks(player.id, parseDecks(body.decks)),
    '/api/rooms/swap-seats': ({ room, player, body }) => room.swapSeats(player.id, String(body.a ?? ''), String(body.b ?? '')),
    '/api/rooms/set-turn-time': ({ room, player, body }) => room.setTurnSeconds(player.id, parseTurnSeconds(body.seconds)),
    '/api/rooms/deal-mode': ({ room, player, body }) => room.setDealMode(player.id, parseDealMode(body.on)),
    '/api/rooms/start': ({ room, player }) => room.start(player.id),
    '/api/rooms/play': ({ room, player, body }) => room.play(player.id, parseCards(body.cards)),
    '/api/rooms/pass': ({ room, player }) => room.pass(player.id),
    '/api/rooms/return': ({ room, player, body }) => room.submitReturn(player.id, parseCard(body.card)),
    '/api/rooms/claim-three': ({ room, player }) => room.claimThree(player.id),
    '/api/rooms/ready': ({ room, player }) => room.markReady(player.id),
    '/api/rooms/pause': ({ room, player }) => { limits.pause.hit(`${player.id}|pause`); room.pause(player.id); },
    '/api/rooms/resume': ({ room, player }) => { limits.pause.hit(`${player.id}|resume`); room.resume(player.id); },
    '/api/rooms/next': ({ room, player }) => room.nextHand(player.id),
    '/api/rooms/restart': ({ room, player }) => room.restart(player.id),
  };

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, rooms: hub.rooms.size });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { room, player } = hub.authenticate(parseCode(url.searchParams.get('room')), parseToken(url.searchParams.get('token')));
      return hub.connect(room, player, req, res);
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const body = await readJson(req);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (open[url.pathname]) return sendJson(res, 200, await open[url.pathname](body, ip));
    const handler = authed[url.pathname];
    if (!handler) throw new HttpError(404, 'not_found');
    const { room, player } = hub.authenticate(parseCode(body.code), parseToken(body.token));
    handler({ room, player, body });
    return sendJson(res, 200, { ok: true, version: room.version });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method_not_allowed');
      if (url.pathname.startsWith('/engine/')) return serveFile(res, engineRoot, url.pathname.slice('/engine'.length));
      // Pretty URLs for shareable pages; the page script reads the id / name from the path.
      if (/^\/replay\/\d+$/.test(url.pathname)) return serveFile(res, publicRoot, '/replay.html');
      if (/^\/u\/[^/]+$/.test(url.pathname)) return serveFile(res, publicRoot, '/profile.html');
      if (url.pathname === '/admin') return serveFile(res, publicRoot, '/admin.html');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      return serveFile(res, publicRoot, pathname);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.code);
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'server_error');
      else res.end();
    }
  });

  server.maxConnections = MAX_CONNECTIONS;
  const sweeper = setInterval(() => {
    hub.sweep();
    for (const limiter of Object.values(limits)) limiter.prune();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    for (const code of [...hub.rooms.keys()]) hub.deleteRoom(code);
  });
  return { server, hub };
}
