// Renders extension/icons/icon.svg into the PNG sizes Chrome needs.
// The 128px icon keeps a 16px transparent margin, as the Chrome Web Store asks.
//   node scripts/icons.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const svg = await fs.readFile(path.join(root, 'extension/icons/icon.svg'), 'utf8');
const sizes = [
  { size: 16, padding: 0 },
  { size: 32, padding: 0 },
  { size: 48, padding: 0 },
  { size: 128, padding: 16 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const { size, padding } of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = size - 2 * padding;
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      `<div style="padding:${padding}px;width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div>` +
      `</body></html>`
  );
  await page.screenshot({ path: path.join(root, `extension/icons/icon${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('Icons written to extension/icons/');
