import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { Accounts } from './accounts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.DATA_DIR ?? path.join(root, 'data');

const db = openDatabase(path.join(dataDir, '510k.db'));
const accounts = new Accounts(db);
const { server, hub } = createApp({
  publicDir: path.join(root, 'public'),
  engineDir: path.join(root, 'engine'),
  accounts,
  admins: (process.env.ADMIN_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});

// Rooms saved by the previous process come back before anyone can connect.
const restored = hub.restoreAll(db);
if (restored) console.log(`restored ${restored} room(s) from the last shutdown`);

server.listen(port, host, () => {
  console.log(`5-10-K server listening on http://${host}:${port} (data: ${dataDir})`);
});

// On stop (systemd sends SIGTERM): refuse new connections, freeze rooms, close streams, save rooms, exit.
// Everything runs synchronously, so no request can slip in between saving and exiting.
let stopping = false;
function shutdown(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  let code = exitCode;
  try {
    server.close();
    server.closeIdleConnections();
    hub.stop();
    const saved = hub.saveAll(db);
    console.log(`${signal}: saved ${saved} room(s), exiting`);
  } catch (err) {
    console.error(`${signal}: failed to save rooms`, err);
    code = 1;
  }
  try {
    db.close();
  } catch (err) {
    console.error('failed to close the database', err);
  }
  process.exit(code);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A bug that escapes every handler: log it, save the rooms like on SIGTERM, and exit non-zero so systemd restarts us.
function crash(kind, err) {
  console.error(`${kind}:`, err);
  if (stopping) return; // already shutting down
  shutdown(kind, 1);
}
process.on('uncaughtException', (err) => crash('uncaughtException', err));
process.on('unhandledRejection', (err) => crash('unhandledRejection', err));
