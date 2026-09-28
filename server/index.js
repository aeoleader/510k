import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { Accounts } from './accounts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.DATA_DIR ?? path.join(root, 'data');

const accounts = new Accounts(openDatabase(path.join(dataDir, '510k.db')));
const { server } = createApp({
  publicDir: path.join(root, 'public'),
  engineDir: path.join(root, 'engine'),
  accounts,
  admins: (process.env.ADMIN_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});
server.listen(port, host, () => {
  console.log(`5-10-K server listening on http://${host}:${port} (data: ${dataDir})`);
});
