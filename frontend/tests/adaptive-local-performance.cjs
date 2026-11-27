const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');

const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:8088/';
const modelPath = path.resolve(process.env.BENCHMARK_MODEL || 'tests/generated/benchmark-500000.ply');
const durationMs = Number(process.env.BENCHMARK_DURATION_MS || 6000);
const resultDir = path.resolve(process.env.BENCHMARK_RESULT_DIR || 'results/adaptive-local');

async function configurePage(browser, { threshold, quality, enableSharedSort = false, disableOnDemand = false }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ value, enableSharedSort, disableOnDemand }) => {
    window.LUMA_ENABLE_SHARED_SORT = enableSharedSort;
    window.LUMA_DISABLE_ADAPTIVE_ON_DEMAND = disableOnDemand;
    window.LUMA_DIRECT_SPLAT_LIMIT = 99_000_000;
    window.LUMA_ADAPTIVE_LOD_THRESHOLD = value;
  }, { value: threshold, enableSharedSort, disableOnDemand });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#qualitySelect').selectOption(quality);
  return { page, errors };
}

async function loadModel(page, mode) {
  const started = Date.now();
  await page.locator('#fileInput').setInputFiles(modelPath);
  if (mode === 'lod') {
    await page.waitForFunction(() => window.__lumaPagedViewer?.localLod === true, null, { timeout: 180000 });
    await page.waitForFunction(() => window.__lumaPagedViewer?.home && window.__lumaPagedViewer.spark.activeSplats > 0, null, { timeout: 180000 });
  } else {
    await page.waitForFunction(() => window.__lumaViewer?.splatMesh?.getSplatCount?.() > 0, null, { timeout: 180000 });
    await page.waitForFunction(() => window.__lumaViewer?.splatRenderReady === true, null, { timeout: 180000 });
  }
  await page.waitForFunction(() => !document.querySelector('#loading').classList.contains('visible'), null, { timeout: 180000 });
  return Date.now() - started;
}

async function measureDirect(page, adaptive) {
  return page.evaluate(async ({ durationMs, adaptive }) => {
    const viewer = window.__lumaViewer;
    const gl = viewer.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const target = viewer.controls.target.clone();
    const radius = viewer.camera.position.distanceTo(target);
    const originalRender = viewer.renderer.render;
    let renderedFrames = 0;
    viewer.renderer.render = function measuredRender(...args) {
      const result = originalRender.apply(this, args);
      gl.finish();
      renderedFrames++;
      return result;
    };
    const started = performance.now();
    let nextInteractionSignal = 0;
    await new Promise(resolve => {
      const tick = now => {
        const elapsed = now - started;
        if (adaptive && now >= nextInteractionSignal) {
          document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1 }));
          nextInteractionSignal = now + 100;
        }
        const angle = elapsed / 1000 * 0.55;
        viewer.camera.position.set(target.x + Math.sin(angle) * radius, target.y + radius * 0.12, target.z + Math.cos(angle) * radius);
        viewer.camera.lookAt(target);
        viewer.controls.update();
        if (elapsed >= durationMs) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = performance.now() - started;
    const pixelRatio = viewer.renderer.getPixelRatio();
    const qualityPhase = window.__lumaClientQualityPhase;
    viewer.renderer.render = originalRender;
    return {
      fps: renderedFrames * 1000 / elapsedMs,
      renderedFrames,
      elapsedMs,
      pixelRatio,
      qualityPhase,
      rendererName,
      activeSplats: viewer.splatMesh.getSplatCount()
    };
  }, { durationMs, adaptive });
}

async function measureIdle(page, idleDurationMs = 2000) {
  return page.evaluate(async idleDurationMs => {
    const viewer = window.__lumaViewer;
    const gl = viewer.renderer.getContext();
    const originalRender = viewer.renderer.render;
    let renderedFrames = 0;
    viewer.renderer.render = function measuredIdleRender(...args) {
      const result = originalRender.apply(this, args);
      gl.finish();
      renderedFrames++;
      return result;
    };
    const started = performance.now();
    await new Promise(resolve => setTimeout(resolve, idleDurationMs));
    const elapsedMs = performance.now() - started;
    viewer.renderer.render = originalRender;
    return { renderedFrames, elapsedMs, fps: renderedFrames * 1000 / elapsedMs };
  }, idleDurationMs);
}

async function captureLod(page, key) {
  return page.evaluate(key => {
    const viewer = window.__lumaPagedViewer;
    window.__adaptiveBenchmarkImages ||= {};
    window.__adaptiveBenchmarkImages[key] = viewer.screenshot();
    return {
      activeSplats: viewer.spark.activeSplats,
      pixelRatio: viewer.renderer.getPixelRatio(),
      lodSplatScale: viewer.spark.lodSplatScale,
      lodRenderScale: viewer.spark.lodRenderScale
    };
  }, key);
}

async function compareLodCaptures(page, first, second) {
  return page.evaluate(async ({ first, second }) => {
    const decode = source => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
    const [a, b] = await Promise.all([
      decode(window.__adaptiveBenchmarkImages[first]),
      decode(window.__adaptiveBenchmarkImages[second])
    ]);
    const width = 640;
    const height = 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(a, 0, 0, width, height);
    const pixelsA = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(b, 0, 0, width, height);
    const pixelsB = context.getImageData(0, 0, width, height).data;
    let squaredError = 0;
    let absoluteError = 0;
    let samples = 0;
    for (let index = 0; index < pixelsA.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const difference = pixelsA[index + channel] - pixelsB[index + channel];
        squaredError += difference * difference;
        absoluteError += Math.abs(difference);
        samples++;
      }
    }
    const mse = squaredError / samples;
    return {
      mse,
      mae: absoluteError / samples,
      psnr: mse === 0 ? null : 10 * Math.log10(255 * 255 / mse)
    };
  }, { first, second });
}

async function saveCapture(page, key, name) {
  const dataUrl = await page.evaluate(key => window.__adaptiveBenchmarkImages[key], key);
  await fs.writeFile(path.join(resultDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function measureLod(page) {
  const viewerInfo = await page.evaluate(() => {
    const viewer = window.__lumaPagedViewer;
    viewer.reset();
    const gl = viewer.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { rendererName: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  await page.waitForTimeout(1000);
  const settledBefore = await captureLod(page, 'settledBefore');
  const performance = await page.evaluate(async durationMs => {
    const viewer = window.__lumaPagedViewer;
    const gl = viewer.renderer.getContext();
    const target = viewer.controls.target.clone();
    const radius = viewer.camera.position.distanceTo(target);
    const originalRender = viewer.renderer.render;
    let renderedFrames = 0;
    viewer.renderer.render = function measuredRender(...args) {
      const result = originalRender.apply(this, args);
      gl.finish();
      renderedFrames++;
      return result;
    };
    viewer.beginInteraction();
    const started = performance.now();
    await new Promise(resolve => {
      const tick = now => {
        const elapsed = now - started;
        const angle = elapsed / 1000 * 0.55;
        viewer.camera.position.set(target.x + Math.sin(angle) * radius, target.y + radius * 0.12, target.z + Math.cos(angle) * radius);
        viewer.camera.lookAt(target);
        viewer.controls.update();
        viewer.requestRender(4);
        if (elapsed >= durationMs) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = performance.now() - started;
    viewer.renderer.render = originalRender;
    return {
      fps: renderedFrames * 1000 / elapsedMs,
      renderedFrames,
      elapsedMs,
      activeSplats: viewer.spark.activeSplats,
      pixelRatio: viewer.renderer.getPixelRatio(),
      lodSplatScale: viewer.spark.lodSplatScale,
      lodRenderScale: viewer.spark.lodRenderScale
    };
  }, durationMs);
  await page.evaluate(() => window.__lumaPagedViewer.reset());
  await page.waitForTimeout(500);
  const interactiveFixed = await captureLod(page, 'interactiveFixed');
  await page.evaluate(() => window.__lumaPagedViewer.endInteraction());
  await page.waitForFunction(() => window.__lumaPagedViewer?.interacting === false, null, { timeout: 5000 });
  await page.evaluate(() => window.__lumaPagedViewer.reset());
  await page.waitForTimeout(1000);
  const restored = await captureLod(page, 'restored');
  const restoredSimilarity = await compareLodCaptures(page, 'settledBefore', 'restored');
  const interactiveSimilarity = await compareLodCaptures(page, 'settledBefore', 'interactiveFixed');
  return { ...viewerInfo, settledBefore, performance, interactiveFixed, restored, restoredSimilarity, interactiveSimilarity };
}

(async () => {
  await fs.mkdir(resultDir, { recursive: true });
  await fs.access(modelPath);
  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync']
  });
  const output = { baseUrl, modelPath, durationMs, cases: {}, errors: [] };
  try {
    const directCases = [
      { name: 'legacy-direct', quality: 'high', disableOnDemand: true },
      { name: 'on-demand-high', quality: 'high' },
      { name: 'adaptive-direct', quality: 'adaptive' }
    ];
    for (const testCase of directCases) {
      const { name, quality, disableOnDemand = false, enableSharedSort = false } = testCase;
      console.log(`[benchmark] loading ${name}`);
      const context = await configurePage(browser, { threshold: 99_000_000, quality, disableOnDemand, enableSharedSort });
      const loadMs = await loadModel(context.page, 'direct');
      console.log(`[benchmark] ${name} loaded in ${loadMs} ms`);
      await context.page.waitForTimeout(1000);
      await context.page.locator('#viewport canvas').first().screenshot({ path: path.join(resultDir, `${name}.png`) });
      output.cases[name] = {
        loadMs,
        profile: await context.page.evaluate(() => window.__lumaRendererProfile),
        idle: await measureIdle(context.page),
        ...(await measureDirect(context.page, quality === 'adaptive'))
      };
      console.log(`[benchmark] ${name}: ${output.cases[name].fps.toFixed(2)} completed FPS`);
      output.errors.push(...context.errors.map(error => `${name}: ${error}`));
      await context.page.close();
    }
    if (process.env.BENCHMARK_INCLUDE_LOCAL_LOD === '1') {
      console.log('[benchmark] loading adaptive-local-lod');
      const context = await configurePage(browser, { threshold: 1, quality: 'adaptive' });
      const loadMs = await loadModel(context.page, 'lod');
      console.log(`[benchmark] adaptive-local-lod loaded in ${loadMs} ms`);
      output.cases['adaptive-local-lod'] = { loadMs, ...(await measureLod(context.page)) };
      console.log(`[benchmark] adaptive-local-lod: ${output.cases['adaptive-local-lod'].performance.fps.toFixed(2)} completed FPS`);
      for (const [key, name] of [['settledBefore', 'settled-before.png'], ['interactiveFixed', 'interactive.png'], ['restored', 'restored.png']]) {
        await saveCapture(context.page, key, name);
      }
      output.errors.push(...context.errors.map(error => `lod: ${error}`));
      await context.page.close();
    }
  } finally {
    await browser.close();
  }
  const legacyFps = output.cases['legacy-direct'].fps;
  const onDemandFps = output.cases['on-demand-high'].fps;
  const adaptiveFps = output.cases['adaptive-direct'].fps;
  output.summary = {
    onDemandInteractiveRatio: onDemandFps / legacyFps,
    adaptiveInteractionSpeedup: adaptiveFps / legacyFps,
    idleFrameReduction: 1 - output.cases['on-demand-high'].idle.renderedFrames / Math.max(1, output.cases['legacy-direct'].idle.renderedFrames),
    adaptiveLodSpeedup: output.cases['adaptive-local-lod']?.performance.fps / legacyFps || null,
    restoredQualityPsnr: output.cases['adaptive-local-lod']?.restoredSimilarity.psnr || null
  };
  await fs.writeFile(path.join(resultDir, 'metrics.json'), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (output.errors.length || !Number.isFinite(legacyFps) || !Number.isFinite(adaptiveFps)) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
