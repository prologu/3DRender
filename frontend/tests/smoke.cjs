const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:4173';
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--enable-webgl', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.resolve('tests/welcome.png'), fullPage: true });
  const title = await page.title();
  const badge = await page.locator('#webglBadge').textContent();
  await page.locator('#loadDemo').click();
  await page.waitForFunction(() => !document.querySelector('#loading').classList.contains('visible'), null, { timeout: 30000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.resolve('tests/viewer.png'), fullPage: true });
  await page.selectOption('#backgroundSelect', '#18202b');
  await page.selectOption('#qualitySelect', 'performance');
  await page.locator('#resetView').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#screenshot').click();
  const screenshotDownload = await downloadPromise;
  const loaded = await page.locator('#viewport').evaluate(el => el.classList.contains('ready'));
  const splats = await page.locator('#splatCount').textContent();
  const canvasCount = await page.locator('#viewport canvas').count();
  const scene = await page.evaluate(() => {
    const v = window.__lumaViewer;
    const box = v.splatMesh.computeBoundingBox();
    return { camera: v.camera.position.toArray(), target: v.controls.target.toArray(), min: box.min.toArray(), max: box.max.toArray() };
  });
  await page.locator('#fileInput').setInputFiles(path.resolve('tests/test-gaussian.ply'));
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'test-gaussian.ply');
  await page.waitForFunction(() => !document.querySelector('#loading').classList.contains('visible'));
  const plySplats = await page.locator('#splatCount').textContent();
  await page.locator('#fileInput').setInputFiles(path.resolve('tests/test-gaussian.ksplat'));
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'test-gaussian.ksplat');
  await page.waitForFunction(() => !document.querySelector('#loading').classList.contains('visible'));
  const ksplatSplats = await page.locator('#splatCount').textContent();
  const formatApi = await page.evaluate(() => ({ spz: Boolean(window.__lumaViewer && window.__lumaViewer.addSplatScene) }));
  console.log(JSON.stringify({ baseUrl, title, badge: badge.trim(), loaded, splats, plySplats, ksplatSplats, screenshot: screenshotDownload.suggestedFilename(), canvasCount, scene, formatApi, errors }, null, 2));
  await browser.close();
  if (!loaded || canvasCount !== 1 || plySplats !== '1,200' || ksplatSplats !== '9,000' || errors.length) process.exit(1);
})();
