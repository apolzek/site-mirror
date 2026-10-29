// Zips dist/ into site-mirror-<version>.zip (for releases).
import fs from 'node:fs/promises';
import path from 'node:path';
import { zip } from '../src/shared/zip.js';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

const files = {};
for (const name of (await fs.readdir(dist, { recursive: true })).sort()) {
  const full = path.join(dist, name);
  if ((await fs.stat(full)).isFile()) files[name.split(path.sep).join('/')] = new Uint8Array(await fs.readFile(full));
}
const out = path.join(root, `site-mirror-${version}.zip`);
await fs.writeFile(out, Buffer.from(await (await zip(files)).arrayBuffer()));
console.log(`Wrote ${path.relative(root, out)} (${Object.keys(files).length} files)`);
