import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? '0.0.0.0';

const { server } = createApp({ publicDir: path.join(root, 'public'), engineDir: path.join(root, 'engine') });
server.listen(port, host, () => {
  console.log(`5-10-K server listening on http://${host}:${port}`);
});
