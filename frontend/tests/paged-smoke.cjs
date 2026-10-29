const { chromium } = require('playwright-core');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:4173';
  const sceneUrl = process.env.RAD_SCENE_URL || 'https://storage.googleapis.com/forge-dev-public/marble-100-mini/03facf44-511b-42d0-9ddb-9e2a0227e50e_1000000-lod.rad';
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--enable-webgl', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#streamMode').click();
  await page.locator('#streamUrl').fill(sceneUrl);
  await page.locator('#loadStreamUrl').click();
  await page.waitForFunction(() => window.__lumaPagedViewer?.mesh?.isInitialized, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__lumaPagedViewer?.spark?.activeSplats > 0, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => ({
    activeSplats: window.__lumaPagedViewer.spark.activeSplats,
    maxPagedSplats: window.__lumaPagedViewer.spark.maxPagedSplats,
    hasHome: Boolean(window.__lumaPagedViewer.home),
    ready: document.querySelector('#viewport').classList.contains('ready'),
    file: document.querySelector('#fileName').textContent
  }));
  await page.screenshot({ path: path.resolve('tests/paged-viewer.png'), fullPage: true });
  console.log(JSON.stringify({ baseUrl, sceneUrl, ...state, errors }, null, 2));
  await browser.close();
  if (!state.ready || state.activeSplats <= 0 || state.activeSplats > state.maxPagedSplats || errors.length) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
