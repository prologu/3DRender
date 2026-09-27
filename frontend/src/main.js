import './styles.css';

let GaussianSplats3D = null;

const $ = (selector) => document.querySelector(selector);
const els = {
  viewport: $('#viewport'), welcome: $('#welcome'), dropzone: $('#dropzone'), fileInput: $('#fileInput'),
  openFileTop: $('#openFileTop'), loadDemo: $('#loadDemo'), loading: $('#loading'), loadingTitle: $('#loadingTitle'),
  loadingDetail: $('#loadingDetail'), progressBar: $('#progressBar'), progressText: $('#progressText'),
  modelPanel: $('#modelPanel'), toolbar: $('#toolbar'), controlHint: $('#controlHint'), fileType: $('#fileType'),
  fileName: $('#fileName'), fileSize: $('#fileSize'), splatCount: $('#splatCount'), fpsValue: $('#fpsValue'),
  togglePanel: $('#togglePanel'), closePanel: $('#closePanel'), resetView: $('#resetView'), screenshot: $('#screenshot'),
  fullscreen: $('#fullscreen'), backgroundSelect: $('#backgroundSelect'), qualitySelect: $('#qualitySelect'),
  dragOverlay: $('#dragOverlay'), toast: $('#toast'), webglBadge: $('#webglBadge'),
  clientMode: $('#clientMode'), serverMode: $('#serverMode'), serverViewport: $('#serverViewport'),
  serverFrame: $('#serverFrame'), serverMetrics: $('#serverMetrics'), welcomeDescription: $('#welcomeDescription'),
  dropTitle: $('#dropTitle'), dropSubtitle: $('#dropSubtitle'), backendLabel: $('#backendLabel'),
  renderModeLabel: $('#renderModeLabel'), privacyTitle: $('#privacyTitle'), privacyText: $('#privacyText'),
  lodSlider: $('#lodSlider'), lodValue: $('#lodValue'), navPad: $('#navPad')
};

const clientFormats = new Set(['ply', 'splat', 'ksplat', 'spz']);

async function loadClientRenderer() {
  if (!GaussianSplats3D) GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
  return GaussianSplats3D;
}

let viewer = null;
let objectUrl = null;
let activeFile = null;
let toastTimer = null;
let frameCount = 0;
let fpsStartedAt = performance.now();
let dragDepth = 0;
let renderLocation = 'client';
let serverFrameUrl = null;
let serverStatus = null;
let serverRequestRunning = false;
let serverRequestPending = false;
let serverSession = null;
let serverSupportsStream = false;
let serverUpdateRunning = false;
let serverUpdatePending = null;
let serverSettleTimer = null;
let serverMetricsTimer = null;
let streamedFrames = 0;
let streamFpsStartedAt = performance.now();
let serverDrag = null;
let serverPanDrag = null;   // 右键拖动平移（screen-plane pan），与左键旋转区分
let hybridViewer = null;
let hybridPreviewGen = null;
// 本地粗模叠加层（拖动即时反馈）。默认关闭：服务端已可在帧预算内渲染全量点，
// 叠加层只渲染 25% 稀疏点，反而产生空洞与“点被移除/团块”观感。需要即时反馈时置 true。
const USE_HYBRID_PREVIEW = false;
let serverDevice = null;
const serverCamera = { yaw: 0, pitch: 0, distance: 6, pan: [0, 0, 0] };
// 视口相对旋转灵敏度：拖动整个视口高度约转 120°（可控，避免“轻微拖动大量旋转”）。
function rotationSpeed() {
  const h = Math.max(300, els.serverViewport.clientHeight || 720);
  return (120 * Math.PI / 180) / h;
}
// 俯仰钳位：防止相机越过天顶/天底（±90°）。view_matrix 用固定世界 up，越过极点会使画面 180° 翻转（万向锁翻转）；
// 钳到 ±87.1° 可几乎俯视/仰视但不越极，从根源消除上下旋转翻转。yaw 仍无界（水平 360° 自由转）。
const PITCH_LIMIT = Math.PI / 2 - 0.05;
function deviceLabel() {
  const name = (serverDevice || '').replace(/^NVIDIA\s+/i, '').trim();
  return name || 'GPU';
}
const API_BASE = window.LUMA_RENDER_API || window.location.origin;

function hasWebGL2() {
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('webgl2'));
}

function updateCapabilityBadge() {
  const supported = hasWebGL2();
  els.webglBadge.classList.add(supported ? 'ok' : 'error');
  els.webglBadge.lastChild.textContent = supported ? ' WebGL 2 就绪' : ' 不支持 WebGL 2';
  if (!supported) showToast('当前浏览器不支持 WebGL 2，无法启动渲染器', true);
}

function getExtension(name) {
  return name.split('.').pop().toLowerCase();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
}

function formatCount(value) {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function backgroundRgb() {
  const hex = els.backgroundSelect.value.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function serverResolution() {
  return els.qualitySelect.value === 'performance'
    ? { width: 800, height: 450 }
    : { width: 1280, height: 720 };
}

// LOD 滑杆（“置信度”）：选择加载的高斯比例 10%–100%，服务端自适应 LOD 仍会在超帧预算时自动降档。
function lodFraction() {
  return (els.lodSlider ? Number(els.lodSlider.value) : 100) / 100;
}

function serverRenderPayload(interactive = false) {
  const performanceMode = els.qualitySelect.value === 'performance';
  return {
    ...serverCamera,           // 含 yaw/pitch/distance/pan
    ...serverResolution(),     // 交互与静止同分辨率，避免拖动时低清发糊
    background: backgroundRgb(),
    fov: 55,
    lod: lodFraction(),
    jpeg_quality: performanceMode ? 82 : 90
  };
}

function updateModeUi() {
  const server = renderLocation === 'server';
  els.clientMode.classList.toggle('active', !server);
  els.serverMode.classList.toggle('active', server);
  els.serverViewport.classList.toggle('active', server);
  els.viewport.classList.toggle('server-hidden', server);
  els.fileInput.accept = server ? '.ply' : '.ply,.splat,.ksplat,.spz';
  els.welcomeDescription.textContent = server
    ? `模型上传到隔离渲染服务，由 ${deviceLabel()} 完成光栅化，客户端只接收图像。`
    : '所有模型均在当前设备本地解析与渲染，不上传服务器。';
  els.dropTitle.textContent = server ? '上传标准 3DGS PLY 到服务端' : '拖放 3DGS 模型到这里';
  els.dropSubtitle.textContent = server ? '当前支持 binary little-endian PLY' : '或点击从本地选择文件';
  els.backendLabel.textContent = server ? `${deviceLabel()} · gsplat` : 'WebGL 2';
  els.renderModeLabel.textContent = server ? 'Server Frame' : '3D Gaussian';
  els.privacyTitle.textContent = server ? '服务端模式' : '本地模式';
  els.privacyText.textContent = server ? '模型会上传到当前隔离容器' : '文件不会离开你的浏览器';
  els.controlHint.innerHTML = server
    ? `<b>左键拖动</b> 旋转 <i></i><b>右键拖动</b> 移动 <i></i><b>滚轮</b> 缩放 <i></i><b>WASD/方向键/导航盘</b> 移动`
    : '<b>左键</b> 旋转 <i></i><b>右键</b> 平移 <i></i><b>滚轮</b> 缩放';
}

async function switchMode(mode) {
  if (mode === renderLocation) return;
  renderLocation = mode;
  updateModeUi();
  if (mode === 'server') {
    await disposeViewer();
    els.viewport.classList.remove('ready');
    await connectServer();
  } else {
    await closeServerSession();
    void disposeHybridPreview();
    els.serverViewport.classList.remove('ready');
    els.serverFrame.removeAttribute('src');
    if (serverFrameUrl) URL.revokeObjectURL(serverFrameUrl);
    serverFrameUrl = null;
    activeFile = null;
    els.modelPanel.classList.remove('visible');
    els.toolbar.classList.remove('visible');
    els.controlHint.classList.remove('visible');
    els.navPad.classList.remove('visible');
    els.welcome.classList.remove('hidden');
    updateCapabilityBadge();
  }
}

function applyServerModel(model) {
  serverStatus = model;
  serverCamera.yaw = model.camera?.yaw || 0;
  serverCamera.pitch = model.camera?.pitch || 0;
  serverCamera.distance = model.camera?.distance || Math.max(model.radius * 2.6, 1);
  serverCamera.pan = [0, 0, 0];
  activeFile = { name: model.name, size: model.bytes, extension: 'ply', server: true };
  els.fileName.textContent = model.name;
  els.fileType.textContent = 'PLY';
  els.fileSize.textContent = `${formatBytes(model.bytes)} · 服务端`;
  els.splatCount.textContent = formatCount(model.gaussians);
  els.welcome.classList.add('hidden');
  els.modelPanel.classList.add('visible');
  els.toolbar.classList.add('visible');
  els.controlHint.classList.add('visible');
  els.navPad.classList.add('visible');
  els.serverViewport.classList.add('ready');
  void loadHybridPreview();
}

async function connectServer() {
  els.webglBadge.classList.remove('ok', 'error');
  els.webglBadge.lastChild.textContent = ' 连接渲染服务';
  try {
    const response = await fetch(`${API_BASE}/api/status`, { signal: AbortSignal.timeout(8000) });
    const status = await response.json();
    if (!response.ok || !status.ok) throw new Error(status.error || '服务不可用');
    serverDevice = status.device || null;
    serverSupportsStream = Boolean(status.capabilities?.mjpeg_stream);
    updateModeUi();
    els.webglBadge.classList.add('ok');
    els.webglBadge.lastChild.textContent = ` ${deviceLabel()} 就绪 · ${status.gpu.free_mib} MiB`;
    if (status.model) {
      applyServerModel(status.model);
      if (!await openServerSession()) await requestServerRender();
    } else {
      els.welcome.classList.remove('hidden');
      showToast('服务端已连接，请上传 PLY 模型');
    }
  } catch (error) {
    els.webglBadge.classList.add('error');
    els.webglBadge.lastChild.textContent = ' 服务端离线';
    showToast(`服务端连接失败：${readableError(error)}`, true);
  }
}

function uploadServerFile(file) {
  if (getExtension(file.name) !== 'ply') return showToast('服务端模式当前仅支持标准 3DGS PLY', true);
  showLoading(`正在上传到 ${deviceLabel()}`, '准备传输模型…');
  els.openFileTop.disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/model`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) setProgress(event.loaded * 90 / event.total);
  };
  xhr.onerror = () => finishServerUpload(new Error('网络连接中断'));
  xhr.onload = () => {
    let payload = {};
    try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* handled below */ }
    if (xhr.status < 200 || xhr.status >= 300) {
      finishServerUpload(new Error(payload.error || `HTTP ${xhr.status}`));
      return;
    }
    finishServerUpload(null, payload.model);
  };
  xhr.send(file);
}

async function finishServerUpload(error, model) {
  els.openFileTop.disabled = false;
  if (error) {
    hideLoading();
    showToast(`上传或加载失败：${readableError(error)}`, true);
    return;
  }
  setProgress(100);
  applyServerModel(model);
  if (serverSupportsStream && !serverSession) await openServerSession();
  await requestServerRender();
  hideLoading();
  showToast(`${model.name} 已由 ${deviceLabel()} 加载`);
}

function updateStreamMetrics(stats) {
  if (!stats) return;
  const fps = stats.render_ms ? Math.round(1000 / stats.render_ms) : '—';
  els.fpsValue.textContent = fps;
  const lod = stats.gaussians ? ` · ${formatCount(stats.gaussians)} GS` : '';
  els.serverMetrics.textContent = `${stats.width}×${stats.height}${lod} · ${stats.render_ms || '—'} ms · ${stats.peak_allocated_mib || '—'} MiB`;
}

async function closeServerSession() {
  clearTimeout(serverSettleTimer);
  clearInterval(serverMetricsTimer);
  serverSettleTimer = null;
  serverMetricsTimer = null;
  serverUpdatePending = null;
  const closingSession = serverSession;
  serverSession = null;
  els.serverFrame.removeAttribute('src');
  if (closingSession) {
    fetch(`${API_BASE}/api/session/${closingSession}`, {
      method: 'DELETE', keepalive: true
    }).catch(() => {});
  }
}

async function pollServerMetrics() {
  if (!serverSession) return;
  try {
    const response = await fetch(`${API_BASE}/api/session/${serverSession}`, {
      signal: AbortSignal.timeout(3000), cache: 'no-store'
    });
    if (response.ok) updateStreamMetrics((await response.json()).stats);
  } catch (_) { /* the image stream remains authoritative */ }
}

// ── 混合渲染：服务端模式下的本地粗模预览 ──
// 拉取服务端导出的粗模 .splat（25% LOD），在叠加画布上跑本地
// gaussian-splats-3d 实例。拖动/缩放时立即显示本地预览获得即时反馈，
// 对应服务端帧到达且不再拖动时隐藏。
function hybridPreviewElement() {
  let host = document.getElementById('serverPreview');
  if (!host) {
    host = document.createElement('div');
    host.id = 'serverPreview';
    els.serverViewport.prepend(host);
  }
  return host;
}

async function loadHybridPreview() {
  if (!USE_HYBRID_PREVIEW || renderLocation !== 'server' || !serverStatus || hybridViewer) return;
  const generation = serverStatus.model_generation ?? `${serverStatus.name}:${serverStatus.bytes}`;
  if (hybridPreviewGen === generation) return;
  try {
    const lib = await loadClientRenderer();
    const response = await fetch(`${API_BASE}/api/model.splat?frac=0.25`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blobUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' }));
    const preview = new lib.Viewer({
      rootElement: hybridPreviewElement(),
      cameraUp: [0, 1, 0],
      initialCameraPosition: [0, 0, serverStatus.radius * 2.6],
      initialCameraLookAt: [0, 0, 0],
      selfDrivenMode: true,
      useBuiltInControls: true,
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      enableSIMDInSort: true,
      halfPrecisionCovariancesOnGPU: true,
      sphericalHarmonicsDegree: 0,
      sceneRevealMode: lib.SceneRevealMode.Instant,
      renderMode: lib.RenderMode.Always,
      antialiased: false
    });
    await preview.addSplatScene(blobUrl, {
      format: lib.SceneFormat.Splat,
      progressiveLoad: false,
      showLoadingUI: false
    });
    URL.revokeObjectURL(blobUrl);
    preview.start();
    hybridViewer = preview;
    hybridPreviewGen = generation;
    syncHybridCamera();
  } catch (error) {
    console.warn('本地粗模预览不可用，退回纯服务端帧流:', error);
    await disposeHybridPreview();
  }
}

async function disposeHybridPreview() {
  if (hybridViewer) {
    const preview = hybridViewer;
    hybridViewer = null;
    hybridPreviewGen = null;
    try { preview.stop(); } catch (_) { /* already stopped */ }
    try { await preview.dispose(); } catch (_) { /* best-effort cleanup */ }
  }
  document.getElementById('serverPreview')?.remove();
}

function syncHybridCamera() {
  if (!hybridViewer || !serverStatus) return;
  const center = serverStatus.center || [0, 0, 0];
  const { yaw, pitch, distance } = serverCamera;
  const offset = [
    Math.sin(yaw) * Math.cos(pitch) * distance,
    Math.sin(pitch) * distance,
    -Math.cos(yaw) * Math.cos(pitch) * distance
  ];
  hybridViewer.camera.position.set(center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]);
  hybridViewer.controls.target.set(center[0], center[1], center[2]);
  hybridViewer.camera.lookAt(hybridViewer.controls.target);
  hybridViewer.controls.update();
}

function setHybridVisible(visible) {
  document.getElementById('serverPreview')?.classList.toggle('visible', visible);
  // 防重影：本地预览显示的是当前拖动相机，而服务端帧仍是上一时刻相机；
  // 两者错位叠加就是“多帧重叠”。预览可见时隐藏服务端帧，预览淡出后恢复。
  els.serverFrame.style.display = visible ? 'none' : '';
}

async function openServerSession() {
  if (!serverSupportsStream || !serverStatus) return false;
  await closeServerSession();
  try {
    const response = await fetch(`${API_BASE}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverRenderPayload(false))
    });
    if (!response.ok) return false;
    const payload = await response.json();
    serverSession = payload.session;
    els.serverFrame.crossOrigin = 'anonymous';
    els.serverFrame.onload = () => {
      streamedFrames++;
      const now = performance.now();
      if (now - streamFpsStartedAt > 700) {
        els.fpsValue.textContent = Math.max(1, Math.round(streamedFrames * 1000 / (now - streamFpsStartedAt)));
        streamedFrames = 0;
        streamFpsStartedAt = now;
      }
      els.serverViewport.classList.add('ready');
      if (!serverDrag) setHybridVisible(false);
    };
    els.serverFrame.src = new URL(payload.stream_url, API_BASE).href;
    serverMetricsTimer = setInterval(pollServerMetrics, 700);
    return true;
  } catch (_) {
    serverSession = null;
    return false;
  }
}

async function updateServerSession(payload) {
  serverUpdatePending = payload;
  if (serverUpdateRunning || !serverSession) return;
  serverUpdateRunning = true;
  try {
    while (serverUpdatePending && serverSession) {
      const next = serverUpdatePending;
      serverUpdatePending = null;
      const response = await fetch(`${API_BASE}/api/session/${serverSession}/camera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    showToast(`帧流更新失败：${readableError(error)}`, true);
  } finally {
    serverUpdateRunning = false;
    if (serverUpdatePending && serverSession) updateServerSession(serverUpdatePending);
  }
}

function scheduleServerRender(interactive = false) {
  clearTimeout(serverSettleTimer);
  requestServerRender(interactive);
  if (interactive) {
    serverSettleTimer = setTimeout(() => requestServerRender(false), 140);
  }
}

async function requestServerRender(interactive = false) {
  if (renderLocation !== 'server' || !serverStatus) return;
  const request = serverRenderPayload(interactive);
  if (serverSession) {
    updateServerSession(request);
    return;
  }
  if (serverRequestRunning) {
    serverRequestPending = true;
    return;
  }
  serverRequestRunning = true;
  try {
    const response = await fetch(`${API_BASE}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);
    els.serverFrame.onload = () => {
      if (serverFrameUrl) URL.revokeObjectURL(serverFrameUrl);
      serverFrameUrl = nextUrl;
      if (!serverDrag) setHybridVisible(false);
    };
    els.serverFrame.src = nextUrl;
    updateStreamMetrics(JSON.parse(response.headers.get('X-Render-Stats') || '{}'));
  } catch (error) {
    showToast(`服务端渲染失败：${readableError(error)}`, true);
  } finally {
    serverRequestRunning = false;
    if (serverRequestPending) {
      serverRequestPending = false;
      requestServerRender();
    }
  }
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('visible');
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 3600);
}

function showLoading(title = '正在读取模型', detail = '准备数据…') {
  els.loadingTitle.textContent = title;
  els.loadingDetail.textContent = detail;
  setProgress(0);
  els.loading.classList.add('visible');
}

function hideLoading() {
  els.loading.classList.remove('visible');
}

function setProgress(percent) {
  const value = Math.min(100, Math.max(0, Number(percent) || 0));
  els.progressBar.style.width = `${value}%`;
  els.progressText.textContent = `${Math.round(value)}%`;
  els.loadingDetail.textContent = value < 100 ? '正在载入并解析高斯数据…' : '正在构建渲染缓冲区…';
}

function createViewer() {
  return new GaussianSplats3D.Viewer({
    rootElement: els.viewport,
    cameraUp: [0, 1, 0],
    initialCameraPosition: [0, 0, 6],
    initialCameraLookAt: [0, 0, 0],
    selfDrivenMode: true,
    useBuiltInControls: true,
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
    enableSIMDInSort: true,
    halfPrecisionCovariancesOnGPU: false,
    sphericalHarmonicsDegree: 2,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    renderMode: GaussianSplats3D.RenderMode.Always,
    antialiased: false
  });
}

async function disposeViewer() {
  if (viewer) {
    try { viewer.stop(); } catch (_) { /* already stopped */ }
    try { await viewer.dispose(); } catch (_) { /* best-effort cleanup */ }
    viewer = null;
    window.__lumaViewer = null;
  }
  els.viewport.replaceChildren();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function loadScene(source, metadata, extension, skipDispose = false) {
  if (!hasWebGL2()) return showToast('当前浏览器不支持 WebGL 2', true);
  showLoading(metadata.demo ? '正在打开示例场景' : '正在读取模型');
  els.openFileTop.disabled = true;

  try {
    await loadClientRenderer();
    const format = {
      ply: GaussianSplats3D.SceneFormat.Ply,
      splat: GaussianSplats3D.SceneFormat.Splat,
      ksplat: GaussianSplats3D.SceneFormat.KSplat,
      spz: GaussianSplats3D.SceneFormat.Spz
    }[extension];
    if (!skipDispose) await disposeViewer();
    viewer = createViewer();
    activeFile = metadata;
    await viewer.addSplatScene(source, {
      format,
      progressiveLoad: false,
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 5,
      onProgress: (percent) => setProgress(percent)
    });
    viewer.start();
    window.__lumaViewer = viewer;
    viewer.renderer.setClearColor(els.backgroundSelect.value, 1);
    els.viewport.classList.add('ready');
    els.welcome.classList.add('hidden');
    els.modelPanel.classList.add('visible');
    els.toolbar.classList.add('visible');
    els.controlHint.classList.add('visible');
    els.fileName.textContent = metadata.name;
    els.fileType.textContent = metadata.extension.toUpperCase();
    els.fileSize.textContent = metadata.demo ? `${formatBytes(metadata.size)} · 内置示例` : formatBytes(metadata.size);
    els.splatCount.textContent = formatCount(viewer.splatMesh.getSplatCount());
    hideLoading();
    showToast(`${metadata.name} 已就绪`);
  } catch (error) {
    console.error(error);
    await disposeViewer();
    hideLoading();
    els.viewport.classList.remove('ready');
    if (!activeFile) els.welcome.classList.remove('hidden');
    showToast(`加载失败：${readableError(error)}`, true);
  } finally {
    els.openFileTop.disabled = false;
  }
}

function readableError(error) {
  const message = error?.message || String(error);
  if (/ply/i.test(message)) return 'PLY 文件不是有效的 3DGS 数据或属性不完整';
  if (/fetch|network/i.test(message)) return '无法读取模型数据';
  if (/memory|buffer|allocation/i.test(message)) return '设备内存不足，请尝试压缩模型';
  return message.length > 90 ? `${message.slice(0, 87)}…` : message;
}

async function handleFile(file) {
  if (!file) return;
  if (renderLocation === 'server') {
    if (file.size === 0) return showToast('文件为空，无法上传', true);
    uploadServerFile(file);
    return;
  }
  const extension = getExtension(file.name);
  if (!clientFormats.has(extension)) return showToast('仅支持 .ply、.splat、.ksplat 和 .spz 文件', true);
  if (file.size === 0) return showToast('文件为空，无法加载', true);
  await disposeViewer();
  objectUrl = URL.createObjectURL(file);
  await loadScene(objectUrl, { name: file.name, size: file.size, extension }, extension, true);
}

async function loadDemo() {
  if (renderLocation === 'server') {
    if (serverStatus) await requestServerRender();
    else await connectServer();
    return;
  }
  const response = await fetch('./demo.splat', { method: 'HEAD' });
  const size = Number(response.headers.get('content-length')) || 0;
  await loadScene('./demo.splat', { name: 'Luma_Orbit.splat', size, extension: 'splat', demo: true }, 'splat');
}

function resetView() {
  if (renderLocation === 'server') {
    if (!serverStatus) return;
    serverCamera.yaw = serverStatus.camera?.yaw || 0;
    serverCamera.pitch = serverStatus.camera?.pitch || 0;
    serverCamera.distance = serverStatus.camera?.distance || serverStatus.radius * 2.6;
    serverCamera.pan = [0, 0, 0];
    activePanDirs.clear(); recomputePanDir(); updatePanLoop();
    scheduleServerRender(false);
    showToast('服务端视角已重置');
    return;
  }
  if (!viewer) return;
  viewer.camera.position.set(0, 0, 6);
  viewer.controls.target.set(0, 0, 0);
  viewer.camera.lookAt(viewer.controls.target);
  viewer.controls.update();
  showToast('视角已重置');
}

async function saveScreenshot() {
  if (renderLocation === 'server') {
    if (!serverStatus) return;
    try {
      const response = await fetch(`${API_BASE}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...serverRenderPayload(false), lod: 'full', jpeg_quality: 94 })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.download = `${(activeFile?.name || '3dgs').replace(/\.[^.]+$/, '')}-server-view.jpg`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('服务端高清截图已保存');
    } catch (error) {
      showToast(`截图失败：${readableError(error)}`, true);
    }
    return;
  }
  if (!viewer) return;
  viewer.render();
  const link = document.createElement('a');
  link.download = `${(activeFile?.name || '3dgs').replace(/\.[^.]+$/, '')}-view.png`;
  link.href = viewer.renderer.domElement.toDataURL('image/png');
  link.click();
  showToast('截图已保存');
}

function setPanel(open) {
  els.modelPanel.classList.toggle('visible', open);
  els.togglePanel.classList.toggle('active', open);
}

function tickFps(now) {
  frameCount++;
  if (now - fpsStartedAt >= 700) {
    if (renderLocation === 'client') els.fpsValue.textContent = viewer ? Math.round(frameCount * 1000 / (now - fpsStartedAt)) : '—';
    if (viewer?.splatMesh) els.splatCount.textContent = formatCount(viewer.splatMesh.getSplatCount());
    frameCount = 0;
    fpsStartedAt = now;
  }
  requestAnimationFrame(tickFps);
}

els.openFileTop.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') els.fileInput.click(); });
els.fileInput.addEventListener('change', () => { handleFile(els.fileInput.files[0]); els.fileInput.value = ''; });
els.loadDemo.addEventListener('click', () => loadDemo().catch((error) => showToast(readableError(error), true)));
els.clientMode.addEventListener('click', () => switchMode('client'));
els.serverMode.addEventListener('click', () => switchMode('server'));
els.togglePanel.addEventListener('click', () => setPanel(!els.modelPanel.classList.contains('visible')));
els.closePanel.addEventListener('click', () => setPanel(false));
els.resetView.addEventListener('click', resetView);
els.screenshot.addEventListener('click', () => saveScreenshot());
els.fullscreen.addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
els.backgroundSelect.addEventListener('change', () => {
  if (renderLocation === 'server') scheduleServerRender(false);
  else if (viewer) viewer.renderer.setClearColor(els.backgroundSelect.value, 1);
});
els.qualitySelect.addEventListener('change', () => {
  if (renderLocation === 'server') {
    scheduleServerRender(false);
    showToast(els.qualitySelect.value === 'performance' ? '服务端性能模式' : '服务端高清模式');
    return;
  }
  if (!viewer) return;
  const performanceMode = els.qualitySelect.value === 'performance';
  viewer.renderer.setPixelRatio(performanceMode ? 1 : window.devicePixelRatio);
  viewer.updateForRendererSizeChanges();
  showToast(performanceMode ? '已切换至性能模式' : '已切换至高清模式');
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r' && viewer) resetView();
  if (event.key.toLowerCase() === 'f' && viewer) els.fullscreen.click();
});
window.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; els.dragOverlay.classList.add('visible'); });
window.addEventListener('dragover', (event) => { event.preventDefault(); });
window.addEventListener('dragleave', (event) => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; els.dragOverlay.classList.remove('visible'); } });
window.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; els.dragOverlay.classList.remove('visible'); handleFile(event.dataTransfer.files[0]); });

els.serverViewport.addEventListener('pointerdown', (event) => {
  if (renderLocation !== 'server' || !serverStatus) return;
  els.serverViewport.setPointerCapture(event.pointerId);
  if (event.button === 2) {
    // 右键：屏幕平面平移（与左键旋转区分）
    serverPanDrag = { x: event.clientX, y: event.clientY };
  } else {
    // 左键：旋转
    serverDrag = { x: event.clientX, y: event.clientY };
    if (hybridViewer) { setHybridVisible(true); syncHybridCamera(); }
  }
});
els.serverViewport.addEventListener('pointermove', (event) => {
  if (renderLocation !== 'server') return;
  if (serverDrag) {
    const dx = event.clientX - serverDrag.x;
    const dy = event.clientY - serverDrag.y;
    serverDrag = { x: event.clientX, y: event.clientY };
    const rot = rotationSpeed();
    serverCamera.yaw -= dx * rot;
    serverCamera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, serverCamera.pitch + dy * rot));
    syncHybridCamera();
    scheduleServerRender(true);
  }
  if (serverPanDrag) {
    const dx = event.clientX - serverPanDrag.x;
    const dy = event.clientY - serverPanDrag.y;
    serverPanDrag = { x: event.clientX, y: event.clientY };
    const { right, up } = cameraMoveVectors();
    const scale = (serverCamera.distance / Math.max(els.serverViewport.clientHeight || 720, 300)) * 0.6;
    for (let i = 0; i < 3; i++) serverCamera.pan[i] += (-right[i] * dx + up[i] * dy) * scale;
    scheduleServerRender(true);
  }
});
els.serverViewport.addEventListener('pointerup', () => {
  const wasActive = serverDrag || serverPanDrag;
  serverDrag = null; serverPanDrag = null;
  if (wasActive) scheduleServerRender(false);
});
els.serverViewport.addEventListener('pointercancel', () => {
  const wasActive = serverDrag || serverPanDrag;
  serverDrag = null; serverPanDrag = null;
  if (wasActive) scheduleServerRender(false);
});
els.serverViewport.addEventListener('contextmenu', (event) => { if (renderLocation === 'server') event.preventDefault(); });
els.serverViewport.addEventListener('wheel', (event) => {
  if (renderLocation !== 'server' || !serverStatus) return;
  event.preventDefault();
  const min = serverStatus.radius * 0.08;
  const max = serverStatus.radius * 20;
  serverCamera.distance = Math.max(min, Math.min(max, serverCamera.distance * Math.exp(event.deltaY * 0.001)));
  if (hybridViewer) { setHybridVisible(true); syncHybridCamera(); }
  scheduleServerRender(true);
}, { passive: false });

// ===== 前后左右移动（pan）：按住按钮/方向键沿“屏幕轴”平移。屏幕轴与服务端 view_matrix 完全一致，相机越过天顶/天底时也不会反向 =====
let panDir = null;            // { u: 上下系数, r: 左右系数 }（屏幕轴）
let activePanDirs = new Set();
let panRaf = null;
// 屏幕平面方向：up/down=屏幕上/下，left/right=屏幕左/右（始终与画面一致，不反向）
const navDirVectors = { up: { u: 1, r: 0 }, down: { u: -1, r: 0 }, left: { u: 0, r: -1 }, right: { u: 0, r: 1 } };
// 相机屏幕轴（世界系），与服务端 view_matrix 一致：right=cross(worldUp,forward)、up=cross(forward,right)
function cameraMoveVectors() {
  const { yaw, pitch } = serverCamera;
  const forward = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  let right = [forward[2], 0, -forward[0]]; // cross(worldUp=(0,1,0), forward)
  const rn = Math.hypot(right[0], right[2]);
  right = rn < 1e-4 ? [1, 0, 0] : [right[0] / rn, 0, right[2] / rn];
  const up = [ // cross(forward, right) = 屏幕上
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0]
  ];
  const un = Math.hypot(up[0], up[1], up[2]) || 1;
  return { forward, right, up: [up[0] / un, up[1] / un, up[2] / un] };
}
function recomputePanDir() {
  if (!activePanDirs.size) { panDir = null; return; }
  let u = 0, r = 0;
  for (const d of activePanDirs) { u += navDirVectors[d].u; r += navDirVectors[d].r; }
  panDir = { u, r };
}
function updatePanLoop() {
  if (panDir && !panRaf) panRaf = requestAnimationFrame(panTick);
  if (!panDir && panRaf) { cancelAnimationFrame(panRaf); panRaf = null; scheduleServerRender(false); }
}
function panTick() {
  panRaf = null;
  if (!panDir || renderLocation !== 'server' || !serverStatus) return;
  const { up, right } = cameraMoveVectors();
  const step = serverCamera.distance * 0.02;
  for (let i = 0; i < 3; i++) serverCamera.pan[i] += (panDir.u * up[i] + panDir.r * right[i]) * step;
  scheduleServerRender(true);
  if (panDir) panRaf = requestAnimationFrame(panTick);
}
function addPanDir(name) { if (navDirVectors[name] && renderLocation === 'server' && serverStatus) { activePanDirs.add(name); recomputePanDir(); updatePanLoop(); } }
function removePanDir(name) { if (activePanDirs.has(name)) { activePanDirs.delete(name); recomputePanDir(); updatePanLoop(); } }
// 导航盘按钮（按住持续移动）
els.navPad?.querySelectorAll('.nav-btn').forEach((btn) => {
  const dir = btn.dataset.dir;
  const start = (event) => { event.preventDefault(); if (dir === 'stop') { activePanDirs.clear(); recomputePanDir(); updatePanLoop(); return; } addPanDir(dir); btn.classList.add('pressing'); };
  const end = () => { btn.classList.remove('pressing'); removePanDir(dir); };
  btn.addEventListener('pointerdown', start);
  window.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
});
// 键盘：WASD / 方向键
const keyToDir = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
window.addEventListener('keydown', (event) => {
  if (/^(input|select|textarea)$/i.test(event.target.tagName || '')) return;
  const dir = keyToDir[event.key.toLowerCase()];
  if (dir) { event.preventDefault(); addPanDir(dir); }
});
window.addEventListener('keyup', (event) => { const dir = keyToDir[event.key.toLowerCase()]; if (dir) removePanDir(dir); });
if (els.lodSlider) {
  els.lodSlider.addEventListener('input', () => {
    els.lodValue.textContent = els.lodSlider.value + '%';
    if (renderLocation === 'server') scheduleServerRender(false);
  });
}

window.addEventListener('pagehide', () => {
  if (serverSession) {
    fetch(`${API_BASE}/api/session/${serverSession}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
});

updateCapabilityBadge();
updateModeUi();
requestAnimationFrame(tickFps);
