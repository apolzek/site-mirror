// Playwright fixtures: a Chromium with the built extension (dist-test/) loaded, and a
// `mirrorVia` helper that drives the real popup and recorder window, like a user would.
import fs from 'node:fs';
import path from 'node:path';
import { test as base, chromium, expect } from '@playwright/test';

const dist = path.resolve(import.meta.dirname, '../../dist-test');

export const test = base.extend({
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
      throw new Error('dist-test/ is missing: run the tests with `npm run test:e2e`');
    }
    const context = await chromium.launchPersistentContext('', {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({}, use) => {
    await use(fs.readFileSync(path.join(dist, 'extension-id.txt'), 'utf8').trim());
  },

  /**
   * mirrorVia(page, options?) -> { file, filename, status, pages }
   * Opens the popup for `page`, sets the options, clicks "Copy site", waits for the
   * recorder window to finish and saves the download.
   */
  mirrorVia: async ({ context, extensionId }, use, testInfo) => {
    await use(async (page, options = {}) => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      if ('crawl' in options) await popup.check(`input[name="scope"][value="${options.crawl ? 'crawl' : 'page'}"]`);
      for (const [id, value] of Object.entries(options)) {
        if (id === 'crawl') continue;
        if (typeof value === 'boolean') await popup.setChecked(`#${id}`, value);
        else await popup.fill(`#${id}`, String(value));
      }

      // The popup records the active tab of its window.
      await page.bringToFront();
      const recorderOpened = context.waitForEvent('page', (p) => p.url().includes('/recorder.html'));
      await popup.click('#start');
      const recorder = await recorderOpened;
      const download = recorder.waitForEvent('download', { timeout: 170_000 });
      const status = recorder.locator('#status');
      await expect(status).toHaveClass(/\b(ok|err)\b/, { timeout: 170_000 });
      const text = await status.textContent();
      if (!/\bok\b/.test(await status.getAttribute('class'))) throw new Error(`recording failed: ${text}`);

      const saved = await download;
      const file = testInfo.outputPath(saved.suggestedFilename());
      await saved.saveAs(file);
      const pages = await recorder.locator('#pages li').allTextContents();
      await recorder.close();
      return { file, filename: saved.suggestedFilename(), status: text, pages };
    });
  },
});

export { expect };
