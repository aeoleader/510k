import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { HttpError, sendJson, sendError, readJson } from './http.js';
import { parseCards, parseCard, parseName, parseCode, parseDecks, parseToken } from './validate.js';
import { publicAccount } from './accounts.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

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
    });
    fs.createReadStream(file).pipe(res);
  });
}

function roomPayload(room, player) {
  return { code: room.code, token: player.token, playerId: player.id };
}

// accounts: an Accounts instance, or null to run guest-only (no login, no ratings).
export function createApp({ publicDir, engineDir, delays, timers, now, accounts = null } = {}) {
  const hub = new Hub({ delays, timers, now, accounts });
  const publicRoot = path.resolve(publicDir);
  const engineRoot = path.resolve(engineDir);

  // POST handlers: body -> JSON payload. Auth'd handlers receive { room, player, body }.
  const requireAccounts = () => {
    if (!accounts) throw new HttpError(503, 'accounts_disabled');
    return accounts;
  };
  const userFor = (body) => (accounts ? accounts.userForToken(body.accountToken) : null);
  const displayName = (body, user) => (user ? user.username : parseName(body.name));

  const open = {
    '/api/auth/register': (body) => {
      const { token, user } = requireAccounts().register(body.username, body.password);
      return { accountToken: token, account: publicAccount(user) };
    },
    '/api/auth/login': (body) => {
      const { token, user } = requireAccounts().login(body.username, body.password);
      return { accountToken: token, account: publicAccount(user) };
    },
    '/api/auth/me': (body) => {
      const user = requireAccounts().userForToken(body.accountToken);
      if (!user) throw new HttpError(401, 'session_expired');
      return { account: publicAccount(user) };
    },
    '/api/auth/logout': (body) => {
      requireAccounts().logout(body.accountToken);
      return { ok: true };
    },
    '/api/rooms/create': (body) => {
      const user = userFor(body);
      const { room, player } = hub.createRoom(displayName(body, user), user);
      return roomPayload(room, player);
    },
    '/api/rooms/join': (body) => {
      const code = parseCode(body.code);
      const existing = body.token ? hub.getRoom(code).findByToken(parseToken(body.token)) : null;
      if (existing) {
        hub.getRoom(code).rejoined(existing.id);
        return roomPayload(hub.getRoom(code), existing);
      }
      const user = userFor(body);
      const { room, player } = hub.joinRoom(code, displayName(body, user), user);
      return roomPayload(room, player);
    },
  };
  const authed = {
    '/api/rooms/leave': ({ room, player }) => hub.leave(room, player),
    '/api/rooms/add-bot': ({ room, player }) => { room.addBot(player.id); },
    '/api/rooms/remove-player': ({ room, player, body }) => room.removePlayer(player.id, String(body.playerId ?? '')),
    '/api/rooms/set-decks': ({ room, player, body }) => room.setDecks(player.id, parseDecks(body.decks)),
    '/api/rooms/start': ({ room, player }) => room.start(player.id),
    '/api/rooms/play': ({ room, player, body }) => room.play(player.id, parseCards(body.cards)),
    '/api/rooms/pass': ({ room, player }) => room.pass(player.id),
    '/api/rooms/return': ({ room, player, body }) => room.submitReturn(player.id, parseCard(body.card)),
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
    if (open[url.pathname]) return sendJson(res, 200, open[url.pathname](body));
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
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      return serveFile(res, publicRoot, pathname);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.code);
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'server_error');
      else res.end();
    }
  });

  const sweeper = setInterval(() => hub.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    for (const code of [...hub.rooms.keys()]) hub.deleteRoom(code);
  });
  return { server, hub };
}
