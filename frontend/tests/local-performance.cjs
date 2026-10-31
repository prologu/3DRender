const { chromium } = require('playwright-core');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://100.64.0.60:8088/';
  const counts = (process.env.BENCHMARK_COUNTS || '100000,500000,1000000').split(',').map(Number);
  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--enable-webgl', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const results = [];

  for (const count of counts) {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const modelPath = path.resolve(`tests/generated/benchmark-${count}.ply`);
    const startedAt = Date.now();
    await page.locator('#fileInput').setInputFiles(modelPath);
    await page.waitForFunction(expected => document.querySelector('#splatCount')?.textContent.replaceAll(',', '') === String(expected), count, { timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('#loading').classList.contains('visible'));
    const loadMs = Date.now() - startedAt;
    const metrics = await page.evaluate(async () => {
      const gl = window.__lumaViewer.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const viewer = window.__lumaViewer;
      const target = viewer.controls.target.clone();
      const radius = viewer.camera.position.distanceTo(target);
      const originalRender = viewer.render;
      let renderedFrames = 0;
      viewer.render = function measuredRender(...args) {
        const result = originalRender.apply(this, args);
        // Force completion so the number reflects completed GPU frames instead
        // of JavaScript merely enqueueing work faster than the device executes.
        gl.finish();
        renderedFrames++;
        return result;
      };
      const started = performance.now();
      let animationFrames = 0;
      await new Promise(resolve => {
        const tick = now => {
          const elapsed = (now - started) / 1000;
          const angle = elapsed * 0.55;
          viewer.camera.position.set(target.x + Math.sin(angle) * radius, target.y + radius * 0.12, target.z + Math.cos(angle) * radius);
          viewer.camera.lookAt(target);
          viewer.controls.update();
          animationFrames++;
          if (elapsed >= 8) resolve(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const durationMs = performance.now() - started;
      viewer.render = originalRender;
      return { fps: renderedFrames * 1000 / durationMs, renderedFrames, animationFrames, durationMs, renderer };
    });
    results.push({ count, loadMs, ...metrics });
  }

  console.log(JSON.stringify({ baseUrl, results, errors }, null, 2));
  await browser.close();
  if (errors.length || results.some(item => item.fps < Number(process.env.MIN_LOCAL_FPS || 20))) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
