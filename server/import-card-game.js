// One-off: import card-game accounts (username + password) into 510k.
// Usage: node server/import-card-game.js <path/to/card-game/accounts.json> [DATA_DIR]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { Accounts } from './accounts.js';

const [source, dataDirArg] = process.argv.slice(2);
if (!source) {
  console.error('usage: node server/import-card-game.js <accounts.json> [DATA_DIR]');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = dataDirArg ?? process.env.DATA_DIR ?? path.join(root, 'data');
const accounts = new Accounts(openDatabase(path.join(dataDir, '510k.db')));
const summary = accounts.importCardGame(JSON.parse(fs.readFileSync(source, 'utf8')));
console.log(`imported ${summary.imported} account(s)`);
for (const s of summary.skipped) console.log(`skipped ${s.username || '(empty)'}: ${s.reason}`);
