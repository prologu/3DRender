const { chromium } = require('playwright-core');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:4173';
  const loadTimeout = Number(process.env.LOD_TIMEOUT_MS || 120000);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--enable-webgl', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const sceneUploads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => errors.push(`request: ${request.url()} (${request.failure()?.errorText})`));
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/scenes')) sceneUploads.push(request.url());
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#streamMode').click();
  await page.locator('#lodFileInput').setInputFiles(path.resolve('tests/test-gaussian.ply'));
  await page.waitForFunction(() => window.__lumaPagedViewer?.localLod === true, null, { timeout: loadTimeout });
  await page.waitForFunction(() => document.querySelector('#viewport').classList.contains('ready'));
  const result = await page.evaluate(() => ({
    localLod: window.__lumaPagedViewer.localLod,
    fileName: document.querySelector('#fileName').textContent,
    fileType: document.querySelector('#fileType').textContent,
    canvasCount: document.querySelectorAll('#viewport canvas').length,
    loading: document.querySelector('#loading').classList.contains('visible')
  }));
  await page.addInitScript(() => { window.LUMA_DIRECT_SPLAT_LIMIT = 1000; });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#fileInput').setInputFiles(path.resolve('tests/test-gaussian.ply'));
  await page.waitForFunction(() => window.__lumaPagedViewer?.localLod === true, null, { timeout: loadTimeout });
  const autoRouted = await page.locator('#streamMode').evaluate(node => node.classList.contains('active'));
  console.log(JSON.stringify({ baseUrl, ...result, autoRouted, sceneUploads, errors }, null, 2));
  await browser.close();
  if (!result.localLod || !autoRouted || result.fileName !== 'test-gaussian.ply' || result.canvasCount !== 1 || result.loading || sceneUploads.length || errors.length) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
