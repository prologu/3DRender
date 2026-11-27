import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const PAGE_SPLATS = 65_536;

function pageAligned(value) {
  return Math.max(PAGE_SPLATS, Math.floor(value / PAGE_SPLATS) * PAGE_SPLATS);
}

function configuredPageBudget(performanceMode) {
  const configured = Number(window.LUMA_MAX_PAGED_SPLATS);
  if (Number.isFinite(configured) && configured > 0) return pageAligned(configured);
  const mobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 800;
  if (mobile) return pageAligned(performanceMode ? 2_000_000 : 4_000_000);
  return pageAligned(performanceMode ? 4_000_000 : 8_000_000);
}

export class PagedSceneViewer {
  constructor({ root, background, quality = 'high', onProgress, onReady, onStats }) {
    this.root = root;
    this.background = background;
    this.quality = quality;
    this.performanceMode = quality === 'performance';
    this.adaptiveMode = quality === 'adaptive';
    this.interacting = false;
    this.restoreQualityAt = 0;
    this.onProgress = onProgress;
    this.onReady = onReady;
    this.onStats = onStats;
    this.running = true;
    this.dirty = true;
    this.settleFrames = 3;
    this.renderedFrames = 0;
    this.statsStartedAt = performance.now();
    this.lastFitAttemptAt = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100_000);
    this.camera.position.set(0, 0, 6);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(background, 1);
    this.root.replaceChildren(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender(4));
    this.controls.addEventListener('start', () => this.beginInteraction());
    this.controls.addEventListener('end', () => this.endInteraction());

    this.spark = new SparkRenderer({
      renderer: this.renderer,
      onDirty: () => this.requestRender(2),
      maxPagedSplats: configuredPageBudget(this.performanceMode),
      lodSplatScale: this.performanceMode ? 0.55 : 1,
      lodRenderScale: this.performanceMode ? 1.7 : 1,
      numLodFetchers: 3,
      pagedExtSplats: true,
      minSortIntervalMs: this.performanceMode ? 20 : 0
    });
    this.scene.add(this.spark);
    this.applyQualityProfile();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  async load(url, { paged = true, name = null } = {}) {
    this.url = url;
    this.localLod = !paged;
    this.mesh = new SplatMesh({
      url,
      ...(paged ? { paged: true } : { lod: true }),
      onProgress: (event) => {
        const percent = event.lengthComputable && event.total > 0
          ? event.loaded * 100 / event.total
          : Math.min(95, Number(event.loaded) ? 35 : 5);
        this.onProgress?.(percent);
      }
    });
    // Standard 3DGS/Spark datasets use camera-down Y/Z convention.
    this.mesh.quaternion.set(1, 0, 0, 0);
    this.scene.add(this.mesh);
    await this.mesh.initialized;
    if (!this.running) return;
    this.fitToScene();
    this.onProgress?.(100);
    this.onReady?.({
      name: name || decodeURIComponent(new URL(url, window.location.href).pathname.split('/').pop() || 'scene.rad'),
      maxPagedSplats: paged ? this.spark.maxPagedSplats : (this.spark.lodSplatCount || 2_500_000),
      activeSplats: this.spark.activeSplats,
      localLod: !paged
    });
    this.requestRender(20);
  }

  async loadFile(file) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    await this.load(this.objectUrl, { paged: false, name: file.name });
  }

  fitToScene() {
    let box;
    try { box = this.mesh?.getBoundingBox(true); } catch (_) { return false; }
    if (!box || box.isEmpty()) return false;
    this.mesh.updateMatrixWorld(true);
    box.applyMatrix4(this.mesh.matrixWorld);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.01);
    this.home = { center: center.clone(), radius };
    this.controls.target.copy(center);
    this.camera.near = Math.max(radius / 10_000, 0.001);
    this.camera.far = Math.max(radius * 100, 1000);
    this.camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.18, radius * 2.35));
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 0.01;
    this.controls.maxDistance = radius * 40;
    this.controls.update();
    return true;
  }

  requestRender(frames = 2) {
    this.dirty = true;
    this.settleFrames = Math.max(this.settleFrames, frames);
  }

  qualityProfile() {
    if (this.performanceMode) {
      return { lodSplatScale: 0.55, lodRenderScale: 1.7, pixelRatio: 1, minSortIntervalMs: 20 };
    }
    if (this.adaptiveMode && this.interacting) {
      return { lodSplatScale: 0.38, lodRenderScale: 2.2, pixelRatio: 1, minSortIntervalMs: 24 };
    }
    return {
      // A settled desktop view should be limited by the RAD hierarchy and the
      // screen-space error, not by Spark's generic 2.5M desktop target.  A
      // sub-pixel render threshold is important for close architectural views.
      lodSplatScale: 2,
      lodRenderScale: 0.35,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      minSortIntervalMs: 0
    };
  }

  pagingSnapshot() {
    const pager = this.spark.pager;
    if (!pager) return { busy: false, pendingPages: 0, residentPages: 0 };
    const pendingPages = (pager.fetchers?.length || 0) +
      (pager.fetched?.length || 0) +
      (pager.newUploads?.length || 0) +
      (pager.readyUploads?.length || 0) +
      (pager.lodTreeUpdates?.length || 0) +
      (pager.fetchPriority?.length || 0);
    return {
      busy: pendingPages > 0,
      pendingPages,
      residentPages: pager.pageToSplatsChunk?.reduce((count, entry) => count + (entry ? 1 : 0), 0) || 0
    };
  }

  applyQualityProfile() {
    const profile = this.qualityProfile();
    this.spark.lodSplatScale = profile.lodSplatScale;
    this.spark.lodRenderScale = profile.lodRenderScale;
    this.spark.minSortIntervalMs = profile.minSortIntervalMs;
    if (this.renderer.getPixelRatio() !== profile.pixelRatio) {
      this.renderer.setPixelRatio(profile.pixelRatio);
      this.renderer.setSize(Math.max(1, this.root.clientWidth), Math.max(1, this.root.clientHeight), false);
    }
    this.requestRender(4);
  }

  beginInteraction() {
    this.restoreQualityAt = 0;
    if (this.adaptiveMode && !this.interacting) {
      this.interacting = true;
      this.applyQualityProfile();
    }
    this.requestRender(30);
  }

  endInteraction() {
    if (this.adaptiveMode) this.restoreQualityAt = performance.now() + 220;
    this.requestRender(18);
  }

  resize() {
    const width = Math.max(1, this.root.clientWidth);
    const height = Math.max(1, this.root.clientHeight);
    const pixelRatio = this.qualityProfile().pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender(3);
  }

  loop(now) {
    if (!this.running) return;
    if (this.restoreQualityAt && now >= this.restoreQualityAt) {
      this.restoreQualityAt = 0;
      this.interacting = false;
      this.applyQualityProfile();
    }
    // A paged RAD resolves before its first coarse chunk is resident, so its
    // bounding box is initially empty. Fit once when that first useful chunk
    // arrives; do not keep chasing the growing resident-cache bounds.
    if (this.mesh && !this.home && now - this.lastFitAttemptAt > 250) {
      this.lastFitAttemptAt = now;
      this.fitToScene();
    }
    const controlsChanged = this.controls.update();
    if (controlsChanged) this.requestRender(3);
    const paging = this.pagingSnapshot();
    if (paging.busy) this.requestRender(2);
    if (this.dirty || this.settleFrames > 0) {
      this.renderer.render(this.scene, this.camera);
      this.renderedFrames++;
      this.dirty = false;
      this.settleFrames = Math.max(0, this.settleFrames - 1);
    }
    if (now - this.statsStartedAt >= 700) {
      this.onStats?.({
        // A static on-demand view intentionally renders almost no frames; do
        // not present that power-saving idle rate as poor interactive FPS.
        fps: this.renderedFrames >= 3
          ? Math.round(this.renderedFrames * 1000 / (now - this.statsStartedAt))
          : null,
        activeSplats: this.spark.activeSplats,
        maxPagedSplats: this.spark.maxPagedSplats,
        qualityPhase: this.adaptiveMode ? (this.interacting ? 'interactive' : 'settled') : this.quality,
        pixelRatio: this.renderer.getPixelRatio(),
        pendingPages: paging.pendingPages,
        residentPages: paging.residentPages,
        lodSplatScale: this.spark.lodSplatScale,
        lodRenderScale: this.spark.lodRenderScale
      });
      this.renderedFrames = 0;
      this.statsStartedAt = now;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  reset() {
    if (!this.home) return;
    const { center, radius } = this.home;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.18, radius * 2.35));
    this.camera.lookAt(center);
    this.controls.update();
    this.requestRender(8);
  }

  setBackground(color) {
    this.background = color;
    this.renderer.setClearColor(color, 1);
    this.requestRender(2);
  }

  setQuality(quality) {
    this.quality = quality;
    this.performanceMode = quality === 'performance';
    this.adaptiveMode = quality === 'adaptive';
    this.interacting = false;
    this.restoreQualityAt = 0;
    this.applyQualityProfile();
    this.resize();
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
    }
    this.scene.remove(this.spark);
    this.spark.dispose();
    this.renderer.dispose();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.root.replaceChildren();
  }
}
