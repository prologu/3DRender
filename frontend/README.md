# Luma Splat · 3DGS Viewer

一个轻量的 Web 3D Gaussian Splatting 查看器，提供本地渲染、大场景分页渲染和 GPU 服务端渲染三种模式。本地模式的模型不会离开浏览器；分页模式可以选择 RAD/RADC 文件夹上传到当前部署，也可以填写现有 URL。

## 功能

- 支持 `.ply`、`.splat`、`.ksplat`、`.spz`
- 点击选择和全页面拖放导入
- 轨道旋转、平移、缩放、重置视角和全屏
- 模型大小、高斯点数和实时帧率信息
- 背景主题、高清/性能模式和 PNG 截图
- 内置离线 `.splat` 示例
- 本地模式可静态部署，不需要后端和 GPU
- Spark `.rad/.radc` 大场景支持文件、文件夹、拖放和 URL 四种入口
- 内置场景服务支持原始文件上传与 HTTP Range，不依赖 PyTorch/GPU
- 服务端模式优先使用双向 WebSocket，代理不支持时回退 MJPEG，并支持最新相机状态合并和交互式自适应 LOD
- 本地 WebGL 渲染包按需加载，服务端模式首屏更轻

## 本地运行

```bash
npm ci
node scripts/generate-demo.mjs
npm run dev
```

构建生产版本：

```bash
npm run build
```

构建后可直接启动静态站点（源码仓库使用 `dist/`，部署包可使用 `deploy/site/`）：

```bash
PORT=8088 bash ./deploy/run-viewer.sh
```

生产脚本会同时提供页面与大场景上传 API；上传文件默认保存在 `deploy/scenes/`。可用 `SCENE_DIR=/data/luma-scenes` 指向数据盘，用 `MAX_SCENE_GIB=200` 调整单场景上限。Vite `preview` 不提供上传 API。

Node/Python 前置条件、国内镜像、服务端离线依赖和完整联调步骤见[项目根目录 README](../README.md)。

浏览器回归测试使用本机 Chrome；其他平台通过 `CHROME_PATH` 指定可执行文件：

```bash
npm run test:client
VIEWER_URL=http://127.0.0.1:4173 \
RENDER_API=http://127.0.0.1:18090 \
EXPECTED_MODEL=model.ply \
npm run test:server
```

## 浏览器要求

推荐使用最新版 Chrome、Edge 或 Firefox，需要 WebGL 2。超大 PLY 文件的内存占用可能达到文件大小的数倍，面向公网部署时建议后续增加 SOG/KSPLAT 转换与流式加载管线。

## 当前测试部署

- 容器目录：`/workspace/luma-splat-viewer`
- 站点目录：`/workspace/luma-splat-viewer/site`
- 容器内端口：`8088`
- 进程号文件：`/workspace/luma-splat-viewer/server.pid`
- 日志文件：`/workspace/luma-splat-viewer/server.log`

当前 Docker 容器创建时没有向宿主机发布 `8088`，且不能在不重建容器的情况下补加端口映射。测试时使用 SSH 本地转发：

```bash
ssh -N -L 18088:127.0.0.1:8088 A5000-tailscale-ljq
```

然后访问 `http://127.0.0.1:18088`。正式绑定域名时，可在宿主机反向代理到容器，或在维护窗口重建容器并增加 `-p 8088:8088`；这两种操作都不属于当前无中断部署范围。

## 技术基础

渲染核心采用 MIT 许可的 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)，界面与应用逻辑为本项目独立实现。

## 三种渲染模式

页面右上角可切换“本地渲染 / 大场景流式 / 服务端渲染”。大场景模式可以选择一个含有单个 `.rad` 和配套 `.radc` 分块的文件夹、选择多个文件、拖放，或填写已有场景 URL；上传后页面会自动打开场景，服务端通过 HTTP Range 按需返回分块，不要求 CUDA 或 ROCm。

服务端模式将标准 3DGS PLY 上传到 gsplat API，由 PyTorch GPU 后端渲染 JPEG 帧；NVIDIA/CUDA 是稳定路径，RX 7700 XT/ROCm 是实验路径。浏览器通过拖动、滚轮、背景和画质控件更新相机，拖动期间使用 preview LOD，停止后自动细化。帧流优先走同一条双向 WebSocket，代理不支持时自动回退 MJPEG。

本地测试默认端口：

- 查看器：`http://127.0.0.1:18088`
- 渲染 API：`http://127.0.0.1:18090`

对应 SSH 转发：

```bash
ssh -N \
  -L 18088:127.0.0.1:8088 \
  -L 18090:127.0.0.1:8090 \
  A5000-tailscale-ljq
```
