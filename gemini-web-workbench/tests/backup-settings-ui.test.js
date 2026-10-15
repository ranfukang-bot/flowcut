const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');

test('backup settings display size/media and update automatically; warn only above 5 GB', async () => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage(); await page.setContent('<div id="root"></div>');
    await page.evaluate(() => {
      window.backupState = { directory: 'temporary backup folder', backupCount: 7, totalBytes: 5e9, overLimit: false, latest: { zipBytes: 2e9, mediaCount: 123 } };
      window.flowcutDesktop = { backupState: async () => backupState, onState: callback => { window.backupListener = callback; return () => {}; } };
    });
    const bundle = require('esbuild').buildSync({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {LocalBackups} from './local-backups'; createRoot(document.getElementById('root')).render(<LocalBackups/>);`, loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
    await page.addScriptTag({ content: bundle });
    await page.getByText('本份 ZIP：2.00 GB', { exact: true }).waitFor();
    await page.getByText('保留 7 份合计：5.00 GB', { exact: true }).waitFor();
    await page.getByText('媒体对象：123 个', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.evaluate(() => { backupState = { ...backupState, totalBytes: 5e9 + 1, overLimit: true, latest: { zipBytes: 2.1e9, mediaCount: 124 } }; backupListener({ backup: backupState }); });
    await page.getByRole('alert').waitFor(); await page.getByText('媒体对象：124 个', { exact: true }).waitFor();
    await page.getByText('本份 ZIP：2.10 GB', { exact: true }).waitFor();
    await page.evaluate(() => { backupState = { ...backupState, totalBytes: 4e9, overLimit: false }; backupListener({ backup: backupState }); });
    await page.getByRole('alert').waitFor({ state: 'detached' });
  } finally { await browser.close(); }
});
