const { chromium } = require('playwright-core');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:4173';
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--enable-webgl', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  await page.addInitScript(() => { window.LUMA_DIRECT_SPLAT_LIMIT = 99_000_000; });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#fileInput').setInputFiles(path.resolve('tests/test-gaussian.ply'));
  await page.waitForFunction(() => window.__lumaViewer?.splatMesh?.getSplatCount?.() > 0, null, { timeout: 120000 });
  const direct = await page.evaluate(() => ({
    clientMode: document.querySelector('#clientMode').classList.contains('active'),
    streamMode: document.querySelector('#streamMode').classList.contains('active'),
    quality: document.querySelector('#qualitySelect').value,
    crossOriginIsolated: window.crossOriginIsolated,
    profile: window.__lumaRendererProfile,
    settledPixelRatio: window.__lumaViewer.renderer.getPixelRatio()
  }));
  await page.locator('#viewport').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  const directInteractive = await page.evaluate(() => ({
    pixelRatio: window.__lumaViewer.renderer.getPixelRatio(),
    phase: window.__lumaClientQualityPhase
  }));
  await page.waitForFunction(() => window.__lumaClientQualityPhase === 'settled', null, { timeout: 3000 });
  const directRestored = await page.evaluate(() => window.__lumaViewer.renderer.getPixelRatio());

  await page.locator('#streamMode').click();
  await page.waitForFunction(() => document.querySelector('#streamMode').classList.contains('active'));
  await page.locator('#lodFileInput').setInputFiles(path.resolve('tests/test-gaussian.ply'));
  await page.waitForFunction(() => window.__lumaPagedViewer?.localLod === true, null, { timeout: 120000 });
  const lodSettled = await page.evaluate(() => ({
    scale: window.__lumaPagedViewer.spark.lodSplatScale,
    renderScale: window.__lumaPagedViewer.spark.lodRenderScale,
    pixelRatio: window.__lumaPagedViewer.renderer.getPixelRatio()
  }));
  await page.evaluate(() => window.__lumaPagedViewer.beginInteraction());
  const lodInteractive = await page.evaluate(() => ({
    scale: window.__lumaPagedViewer.spark.lodSplatScale,
    renderScale: window.__lumaPagedViewer.spark.lodRenderScale,
    pixelRatio: window.__lumaPagedViewer.renderer.getPixelRatio(),
    interacting: window.__lumaPagedViewer.interacting
  }));
  await page.evaluate(() => window.__lumaPagedViewer.endInteraction());
  await page.waitForFunction(() => window.__lumaPagedViewer?.interacting === false, null, { timeout: 3000 });
  const lodRestored = await page.evaluate(() => ({
    scale: window.__lumaPagedViewer.spark.lodSplatScale,
    renderScale: window.__lumaPagedViewer.spark.lodRenderScale,
    pixelRatio: window.__lumaPagedViewer.renderer.getPixelRatio()
  }));

  console.log(JSON.stringify({ direct, directInteractive, directRestored, lodSettled, lodInteractive, lodRestored, errors }, null, 2));
  await browser.close();
  const ok = direct.clientMode && !direct.streamMode && direct.quality === 'adaptive' &&
    !direct.profile?.sharedSort && !direct.profile?.gpuAcceleratedSort &&
    direct.profile?.renderMode === 'on-change' &&
    !direct.profile?.halfPrecisionCovariancesOnGPU && direct.settledPixelRatio === 1.5 &&
    directInteractive.pixelRatio === 1 && directInteractive.phase === 'interactive' && directRestored === 1.5 &&
    lodSettled.scale === 2 && lodSettled.renderScale === 0.35 &&
    lodInteractive.interacting && lodInteractive.scale < 0.5 &&
    lodInteractive.renderScale > 2 && lodInteractive.pixelRatio === 1 &&
    lodRestored.scale === 2 && lodRestored.renderScale === 0.35 && lodRestored.pixelRatio === 1.5;
  if (!ok || errors.length) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
