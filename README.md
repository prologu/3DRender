# 3DRender

面向 3D Gaussian Splatting（3DGS）的 Web 查看与服务端渲染项目。项目提供三条互补路径：

| 模式 | 渲染位置 | 支持格式 | 适用场景 |
| --- | --- | --- | --- |
| 浏览器本地渲染 | 用户浏览器 / WebGL 2 | `.ply`、`.splat`、`.ksplat`、`.spz` | 快速查看、无需后端、文件不上传 |
| 大场景分页渲染 | 用户浏览器 / Spark 2.4 / WebGL 2 | 预构建 `.rad` + `.radc` | 城市级/任意总规模场景；按视角下载，固定显存工作集 |
| GPU 服务端渲染 | Linux + PyTorch GPU + gsplat | 标准 binary little-endian 3DGS `.ply` | NVIDIA/CUDA 为稳定路径；AMD/ROCm 为实验路径 |

服务端模式优先使用**单条双向 WebSocket**：同一连接上传相机状态、下传统计信息和 JPEG 帧；浏览器不支持或代理阻断 WebSocket 时自动回退 MJPEG。相机控制不等待图像 ACK，每个浏览器动画帧最多发一个最新视角；服务端接收、GPU 渲染和 socket 写出分别运行，只保留一个尚未发送的最新图像，慢链路会覆盖旧图而不会阻塞后续拖动。拖动期间已完成的图像即使被更新的相机 revision 超越也会提交，避免连续 60 Hz 指针事件让画面饿死。拖动时只降低图像分辨率和 JPEG 码率，不减少滑杆选定的 Gaussian 点集；Tailscale `100.64.0.0/10` 地址直接从 256×144 低延迟档开始，其他地址根据 E2E 从 640×360 向 400×225、256×144 单向降级，停止操作后自动补当前质量档的清晰帧。页面同时显示实际流帧率、GPU 渲染耗时、E2E、帧大小和旧帧数。

大场景模式使用 Spark 的预构建 LoD 树和共享 LRU page pool。场景总量可以远大于浏览器显存，实际显存只保留当前视角需要的 4M/8M Gaussian 工作集（移动端默认更低），并通过 `.RADC` 分块并行预取。该模式与 CityGS 的 Spark 路线兼容，但代码完全位于本仓库，没有修改 `citygs-spark-docker`。

页面会按模型规模智能选择本地路径：PLY 头中的 `element vertex`（或 `.splat` 文件长度）不超过设备阈值时使用高画质直接渲染；超过阈值时自动切换到 Spark，在浏览器 Web Worker 中构建自适应 LoD，模型仍不上传。默认阈值按 `navigator.deviceMemory` 为 1M/2M/3M，可在页面加载前用 `window.LUMA_DIRECT_SPLAT_LIMIT` 覆盖。预构建 `.RAD/.RADC` 仍是超大场景和生产发布的首选，因为它支持真正的 HTTP Range/分块按需下载，而浏览器现场构建 LoD 仍需先读取整个源文件。

`yaw` 与 `pitch` 均支持连续 360° 轨道旋转；前后端使用在天顶/天底仍良定义的解析相机基。**左键拖动 = 旋转**、**右键拖动 = 屏幕平面移动**、**滚轮 = 缩放**；导航盘和 `WASD`/方向键也沿屏幕轴移动。高斯加载量滑杆实时设置点数比例上限，完整模型常驻 GPU 的硬上限与 out-of-core 路线见 [大规模场景路线](docs/LARGE_SCENES.md)。多个会话使用独立 PyTorch GPU stream；客户端混合粗模预览默认关闭，需要时用 `USE_HYBRID_PREVIEW=true` 开启。

## 目录

```text
3DRender/
├─ frontend/                      # Vite + GaussianSplats3D Web UI
│  ├─ src/                        # 页面逻辑、Spark 分页查看器与样式
│  ├─ public/                     # 图标和离线示例
│  ├─ tests/                      # 浏览器冒烟测试
│  └─ deploy/                     # 页面 + RAD/RADC 上传与 Range 场景服务
├─ server/                        # PyTorch + CUDA/ROCm + gsplat 服务端
│  ├─ server_render_api.py        # HTTP / WebSocket / MJPEG 渲染 API
│  ├─ setup.sh                    # 在线或离线安装隔离依赖
│  ├─ download-wheels.sh          # Linux 下载离线依赖包
│  ├─ download-wheels.ps1         # Windows 下载 Linux 离线依赖包
│  └─ requirements-cu118.txt      # Python 依赖锁定
└─ docs/                          # 架构与大场景设计说明
```

运行时生成的 `node_modules/`、`server/python/`、模型、上传文件和日志均已加入 `.gitignore`，不会提交到仓库。

## 1. 获取或更新代码

首次下载到 Windows：

```powershell
git clone https://github.com/prologu/3DRender.git D:\desktop\render
```

目录已经存在时，只做安全的快进更新：

```powershell
git -C D:\desktop\render pull --ff-only origin main
```

Linux 使用相同仓库地址，并将目标目录换成实际路径。不要把运行时模型和 `server/python/` 提交到 Git。

## 2. 浏览器本地查看器

### 前置条件

- Node.js `20.19+` 或 `22.12+`；推荐 Node.js 22 LTS。
- Chrome、Edge 或 Firefox 新版本，并支持 WebGL 2。
- 生产静态部署只需要任意 HTTP 服务器；不能直接双击 `dist/index.html`。

### 安装与开发启动

仓库已提供 `package-lock.json` 和 `frontend/.npmrc`，默认使用 npmmirror 国内镜像：

```powershell
cd D:\desktop\render\frontend
npm ci
npm run dev
```

PowerShell 禁止执行 `npm.ps1` 时使用 `npm.cmd ci` 和 `npm.cmd run dev`。Vite 默认监听 `0.0.0.0:5173`，终端会打印实际访问地址。

首次需要重新生成内置演示模型时运行：

```powershell
node scripts\generate-demo.mjs
```

### 生产构建与静态启动

```powershell
cd D:\desktop\render\frontend
npm ci
npm run build
npm run preview
```

构建产物位于 `frontend/dist/`。Linux 也可用项目脚本在 `8088` 提供静态页面：

```bash
cd /path/to/3DRender/frontend
PORT=8088 bash ./deploy/run-viewer.sh
```

脚本会优先使用部署包中的 `deploy/site/`，否则使用源码构建出的 `dist/`；也可通过 `SITE_DIR=/absolute/site` 指定目录。它还会启动不依赖 GPU 的场景上传服务，并从 `SCENE_DIR`（默认 `deploy/scenes/`）提供支持 HTTP Range 的分页资源；`MAX_SCENE_GIB` 默认允许单场景 100 GiB。

`npm run build` 会同时为 JS/CSS/WASM 生成 `.gz`，内置场景服务对浏览器自动返回 gzip，并对带内容哈希的 `/assets/` 设置一年 immutable 缓存。Spark 大场景运行包原始约 2.70 MiB、gzip 后约 0.94 MiB；慢速 Tailscale 首次访问仍可能需要数十秒，之后由浏览器缓存复用。同机或局域网访问不受远端隧道吞吐限制。

### 大场景分页模式

在右上角选择“**大场景流式**”后有四种入口。按以下规模选择即可：

1. **数十万到低百万点**：通常直接留在“本地渲染”，拖入 PLY/SPZ；这是帧率和画质最好的路径。
2. **数百万到约 3000 万点的一次性查看**：点击“直接打开 PLY/SPZ”。Spark 在浏览器后台生成 LoD，不上传文件；内存不足时应改用下一项。
3. **千万点以上、城市级或需要反复访问**：点击“选择整个场景文件夹”，选择包含一个 `.rad` 和全部 `.radc` 分块的目录；页面上传后自动打开。也可以一次多选 RAD/RADC 或直接拖放整组文件。
4. **已经发布的场景**：填写 `.rad` HTTP(S) URL。资源服务器必须支持 Range；跨域部署还必须允许 CORS。

浏览器现场 LoD 和分页流不是同一件事：前者免转换但仍需完整读取源文件，后者只下载当前视角所需 `.radc` 块，可让场景总规模远大于终端显存。Spark 官方给出的现场 LoD 经验上限约 3000 万输入 splat；生产超大场景应离线执行 `build-lod --quality --rad-chunked`。

上传入口要求站点由 `frontend/deploy/run-viewer.sh` 启动；`npm run preview` 只提供静态页面，不能接收上传。上传目录可持久化到单独数据盘：

```bash
SCENE_DIR=/data/luma-scenes MAX_SCENE_GIB=200 PORT=8088 bash ./deploy/run-viewer.sh
```

每组文件必须且只能有一个 `.rad`，并保持转换工具产生的 `.radc` 相对路径和文件名。选择文件夹时浏览器会自动去掉最外层目录。地址方式也可直接分享带场景参数的链接：

```text
http://viewer.example/?scene=https%3A%2F%2Fassets.example%2Fcity-lod.rad
```

外部资源服务器必须允许跨域访问，并支持 HTTP Range；若使用 `--rad-chunked`，需要把 `.rad` 和所有同名 `.radc` 文件一起发布。内置场景服务已经实现 Range，无需额外配置。建议为 `.rad/.radc` 设置长缓存，对入口 HTML 设置 `no-cache`。可在页面加载前配置缓存上限（必须按 65,536 对齐，代码会自动向下对齐）：

```html
<script>window.LUMA_MAX_PAGED_SPLATS = 8_388_608;</script>
```

离线转换采用 Spark 官方 `build-lod`，质量优先并输出可独立缓存的分块：

```bash
git clone https://github.com/sparkjsdev/spark.git
cd spark
npm install
npm run build-lod -- /data/city.ply --quality --rad-chunked
```

转换后将 `city-lod.rad` 与 `city-lod-*.radc` 上传到静态资源服务。完整参数与坐标精度说明见 [Spark LoD 指南](https://github.com/sparkjsdev/spark/blob/main/docs/docs/lod-getting-started.md)。

## 3. GPU 服务端渲染

> NVIDIA/CUDA 仍是 gsplat 的稳定上游路径。AMD 已有官方 ROCm 包与上游 HIP PR，但 Radeon 支持尚未正式合并；本仓库提供 RX 7700 XT（`gfx1101`）实验构建脚本与 ROCm 7.14 兼容补丁。大场景 Spark 浏览器模式不依赖这套 GPU 服务端，无论 HIP 扩展是否可用都能运行。

### 前置条件与固定版本

- Linux x86_64，已验证 Ubuntu 22.04。
- CPython 3.10；预编译 wheel 名称包含 `cp310`，其他 Python 版本不能直接使用。
- NVIDIA 驱动可运行 CUDA 11.8 构建的 PyTorch，先确认 `nvidia-smi` 正常。
- 已验证组合：PyTorch `2.0.1+cu118`、gsplat `1.5.3+pt20cu118`、NumPy `1.26.4`、Pillow `10.4.0`、setuptools `80.10.2`（必须 <81，setuptools 81 移除了渲染路径用到的 `pkg_resources`）；`opencv-python-headless` 可选，个别构建上作为更快的 JPEG 后端（`LUMA_JPEG_BACKEND=opencv`）。
- 依赖安装到 `server/python/`，不修改系统 Python，也不创建或停止系统服务。

### AMD RX 7700 XT / ROCm 实验路径

现有 `ljq-rocm` conda 环境可继续使用，不需要每次执行 Python 前手动 `source` 同一个脚本；但**每个新的 SSH shell** 都要重新 `conda activate`，因为激活只修改当前 shell。长期服务直接给 `LUMA_PYTHON` 绝对路径即可，不依赖 shell 激活状态。

```bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate ljq-rocm
python - <<'PY'
import torch
print(torch.__version__, torch.version.hip)
print(torch.cuda.is_available(), torch.cuda.get_device_name(0))
print(torch.cuda.get_device_properties(0).gcnArchName)
PY
```

构建 gsplat HIP 扩展需要运行时包之外的编译器和开发头。优先从 AMD multi-arch 仓库补齐开发轮，然后执行仓库脚本：

```bash
python -m pip install --index-url https://repo.amd.com/rocm/whl-multi-arch/ rocm-sdk-devel==7.14.1
PYTORCH_ROCM_ARCH=gfx1101 MAX_JOBS=2 bash ./server/setup-rocm-gsplat.sh
```

`setup-rocm-gsplat.sh` 固定使用已验证的 gsplat HIP PR revision，并应用 ROCm 7.14 的 cooperative-groups 兼容补丁。AMD 仓库下载较慢时，脚本也支持把 rocThrust、rocPRIM、hipCUB 等头文件放在 `~/luma/rocm-headers` 的轻量回退方式。启动时无需重新激活环境：

```bash
LUMA_PYTHON="$HOME/miniconda3/envs/ljq-rocm/bin/python" \
PHYSICAL_GPU=0 MEMORY_FRACTION=0.70 MIN_FREE_MIB=1024 \
bash ./server/run-render-server.sh
```

建议先检查：

```bash
python3 --version     # 必须是 3.10.x
nvidia-smi
df -h /workspace     # 离线包和解包后的环境需要数 GiB 空间
```

### 方案 A：服务器可以联网

`setup.sh` 使用清华 PyPI 镜像和上海交大 PyTorch wheel；gsplat 优先使用 `server/wheels/` 中的本地文件，否则从官方 GitHub Release 下载：

```bash
cd /path/to/3DRender/server
APP_ROOT="$PWD" bash ./setup.sh
```

安装结束会打印 PyTorch、CUDA、gsplat 版本以及 `torch.cuda.is_available()`。

### 方案 B：容器不能访问外网（推荐用于当前服务器）

先在有网络的 Linux x86_64 + Python 3.10 设备下载：

```bash
cd /path/to/3DRender/server
bash ./download-wheels.sh
```

也可以在 Windows PowerShell 下载目标为 Linux CPython 3.10 的离线包：

```powershell
cd D:\desktop\render\server
.\download-wheels.ps1
```

完成后将整个 `server/` 目录上传到容器，确保 `server/wheels/` 一并传输，然后离线安装：

```bash
cd /workspace/luma-server-render
OFFLINE=1 APP_ROOT="$PWD" bash ./setup.sh
```

`wheels/` 和安装后的 `python/` 已被 Git 忽略。不要把约数 GiB 的二进制依赖提交到 GitHub。

### 启动 API

先查看各 GPU 的空闲显存，不要占用他人的进程：

```bash
nvidia-smi
```

启动服务；`MODEL_PATH` 可省略，之后从网页上传 PLY：

```bash
cd /workspace/luma-server-render
PHYSICAL_GPU=3 \
RENDER_PORT=8090 \
MODEL_PATH=/absolute/path/model.ply \
bash ./run-render-server.sh
```

专用 GPU 机器（如单卡 A5000）建议用隔离 conda 环境并提高显存预算：

```bash
conda create -n luma python=3.10 -y
LUMA_PYTHON="$HOME/miniconda3/envs/luma/bin/python3" \
PHYSICAL_GPU=0 \
MEMORY_FRACTION=0.25 \
MODEL_PATH=/absolute/path/model.ply \
bash ./run-render-server.sh
```

常用环境变量：

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `PHYSICAL_GPU` | `0` | 绑定的物理 GPU 编号 |
| `RENDER_PORT` | `8090` | API 监听端口 |
| `MODEL_PATH` | 空 | 启动时加载的标准 3DGS PLY |
| `MEMORY_FRACTION` | `0.045` | PyTorch 单进程显存比例上限；共享 GPU 保持保守，专用 GPU 可提到 `0.25`+（24G 卡 ≈ 6 GiB，可常驻约 50M SH0 点） |
| `MIN_FREE_MIB` | `1750` | 加载和渲染前要求的最小空闲显存 |
| `MAX_UPLOAD_GIB` | `2.0` | 单个上传模型的大小上限 |
| `MAX_SESSIONS` | `4` | 最大交互会话数 |
| `SESSION_TTL` | `120` | 无流连接会话的回收秒数，最低 30 |
| `FRAME_BUDGET_MS` | `33` | 服务端自适应 LOD 的目标帧时间预算（毫秒），默认 33 ≈ 30fps |
| `AUTO_LOD` | `true` | 启用服务端自适应 LOD；`false` 时严格使用客户端请求的档位 |
| `LUMA_PYTHON` | `python3` | 启动使用的 Python 解释器（隔离部署指向 conda 环境路径） |
| `LUMA_JPEG_BACKEND` | `pillow` | JPEG 编码后端，可设 `opencv`（需装 opencv-python-headless） |
| `SPATIAL_LOD` | `false` | 启用实验性空间 LOD（按视锥 + 屏幕空间误差选叶节点）；`false` 时 LOD 只按重要性前缀截取 |
| `UPLOAD_DIR` | `server/uploads` | 上传文件保存目录 |

显存比例不是模型容量保证。应根据模型 Gaussian 数、分辨率和同卡已有任务保守调整；脚本不会自动结束其他进程。

### API 健康检查

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/api/status
```

主要接口：`POST /api/model`、`POST /api/render`、`POST /api/session`、`GET /api/session/{id}/ws`（首选双向帧流）、`POST /api/session/{id}/camera` + `GET /api/session/{id}/stream`（MJPEG 兼容路径）、`GET /api/model.splat?frac=0.25`。请求细节见 [技术架构](docs/ARCHITECTURE.md)。

### 性能优化（服务端帧流水线）

当前版本已实现，A5000 部署实测（1.16M Gaussian 场景，960×540，full LOD）：

| 优化 | 行为 | 实测数据 |
| --- | --- | --- |
| WebSocket latest-frame 流水 | 相机 JSON 与 JPEG 帧复用一条持久连接；二进制帧为 `4-byte stats 长度 + stats JSON + JPEG`。控制消息按 RAF 合并、完全不等待下行图像确认；服务端接收/渲染/写 socket 解耦，出站只有一个可覆盖槽，TCP 发送缓冲受限；浏览器解码拥塞时也只画最新帧 | 消除 ACK 窗口和阻塞 `sendall` 造成的旧视角长队列；1M/RX 7700 XT 的连续拖动实测从约 6 FPS、746–2759 ms E2E 改善到 25.4 FPS，松手后的 1280×720 清晰帧 E2E 166 ms；`client_seq`、`jpeg_bytes` 与 `dropped_frames` 可观察背压 |
| 交互码率自适应 | 高清/性能的静止帧仍为 1280×720 / 800×450；Tailscale 地址直接用 256×144，其他地址从 640×360 开始，E2E 超过 450 ms 时依次降到 400×225、256×144，JPEG 质量为 30–58；页面生命周期内只降不升，停止拖动后补发 82/90 清晰帧 | 避免 Tailscale 上用两个 RTT 探测已知不可持续的高码率，也避免 256p/640p 来回振荡；不会让一张 720p JPEG 阻塞后续相机状态 |
| 旋转点集锁定 | 网页端所有会话使用 `lock_lod=true`；旋转帧与静止帧使用完全相同的滑杆点数，只在交互期间改变输出图像尺寸和 JPEG 质量。协议统计返回 `interactive`、`lod_locked` 便于自动测试 | 2,146,592 点回归中每一帧仍使用 2,146,592 点；50% 滑杆下每一帧均为 1,073,296 点，不再出现 100%↔25%/35% 结构跳变 |
| 服务端自适应 LOD | 未设置 `lock_lod=true` 的 API 客户端，帧耗时超过 `FRAME_BUDGET_MS` 时按比例自动降 LOD，客户端档位为上限，有余量逐步回升 | 网页默认锁定点集以保证视觉连续；批处理或自定义客户端可不锁定并选择“帧率优先”的自动 LOD |
| 空闲帧提交 | 相机静止 100 ms 后仅补发一次已编码 JPEG，促使 Chromium 提交首帧/最终帧；不重新调用 GPU 渲染，也不持续传输 | 浏览器静止首帧可见；之后保持空闲，无连续重传 |
| 多会话 CUDA stream 并发 | 移除渲染路径全局锁，每个渲染调用从流池取独立 `torch.cuda.Stream`（池大小 = 会话上限），仅模型加载保留互斥 | 相机 50ms 更新下：单会话 19.6 fps，双会话各 19.3 fps，四会话各 18.9 fps（与单会话持平，无头程阻塞） |
| LOD 选点策略（重要性前缀为默认） | 默认按 `不透明度 × 最大尺度²` 的重要性前缀截取（每个 LOD 都是同一组张量的稳定前缀，质量切换不重排、不建索引缓冲）。实测该模型所有高斯尺度几乎均匀（max_scale≈0.009），重要性≈不透明度，top-N 前缀天然把表面铺满、无可见空洞；空间叶选择（`--spatial-lod`，近处贪心）对这类表面模型会饿死远处覆盖（2.35% 洞），故降为实验项默认关闭 | 25% 预算（960×540）：前缀 290K 点，渲染 8.8 ms（≤33 ms 预算）；恢复后 25% 帧与旧版前缀帧逐像素一致（diff 0.00%），可见像素覆盖率 10.27% |
| 任意方向连续 360° 旋转 | `yaw`、`pitch` 仅做周期归一化，不做俯仰钳位；前后端统一使用解析 `forward/right/up` 基，`right` 不再由 `cross(worldUp, forward)` 求得，因此经过 ±90° 两个极点时不退化、不跳变 | A5000 浏览器实测 2,146,592 点：拖动后 `pitch=1.759 rad`（约 100.8°，已越过旧 ±87° 限制），三个基向量长度均为 1、两两点积约 0；服务端单元测试覆盖两个极点、完整 2π 周期和超大角度 |
| 显式质量控制 | “高清/性能”选择停止操作后的 1280×720 或 800×450 清晰帧；高斯加载量滑杆选择 10%–100% 固定点集。交互图像分辨率自动降低，但点集不变 | 用户仍明确控制模型结构完整度；短暂的交互低分辨率换取响应速度，停止后恢复清晰度 |
| 客户端混合渲染（默认关闭） | 服务端导出 25% 粗模（`GET /api/model.splat`，32 字节/点），前端叠加画布本地渲染以提供拖动即时反馈。因服务端已可在帧预算内渲染全量点，叠加层只渲染 25% 稀疏点反而产生空洞，故默认关闭（`USE_HYBRID_PREVIEW`，置 true 重新启用） | 默认下拖动直接显示全质量服务端帧（1,160,393 点、15-19 ms）；需要本地即时反馈时开启叠加层（9.3 MB 粗模下载一次） |
| 交互手感 + 前后左右移动 + 高斯加载量滑杆 | ① 旋转前后保持同一固定点集；② 旋转灵敏度按视口尺寸计算（拖满视口高约转 120°）；③ 导航盘和键盘沿相机屏幕轴累计 `pan`，步长随距离缩放；④ 10%–100% 滑杆直接设置固定点数比例 | 旋转、移动、缩放三种操作互不混淆；跨极点移动方向保持一致；降低点数只会在用户调整滑杆时发生 |
| 旋转与移动区分 + 指针捕获兜底 | ① **左键拖动 = 旋转、右键拖动 = 移动（屏幕平面平移）、滚轮 = 缩放**——鼠标键位明确区分旋转与移动（右键菜单已屏蔽）；② 导航盘（↑↓←→ + 中心停止）与 `WASD`/方向键使用**屏幕轴**，并与服务端共享同一组连续解析相机基；③ 使用 Pointer Capture、合并高频 pointer sample，并由 window 级 `pointerup/pointercancel` 和 `lostpointercapture` 共同收尾 | 鼠标移出视口、全屏/UI 抢占或操作系统中断捕获后都不会出现“拖不动”或“松手后仍卡住”；浏览器测试核对左键只改 yaw/pitch、右键只改 pan |

浏览器侧 out-of-core 分块流式加载已由 Spark `.RAD/.RADC` 路线落地；服务端 Python/gsplat 路径仍是完整模型常驻 GPU。后续服务端 tile cache 与 WebRTC/H.264 多用户视频传输见 [大规模场景路线](docs/LARGE_SCENES.md)。当前 WebSocket 传 JPEG 已解决控制排队，但不是视频编码器，公网高并发仍建议 WebRTC。

可用连续拖动基准核对真实到达帧率（测试会输出 `delivered_fps`、发送相机数、E2E 和当前码率）：

```bash
cd frontend
VIEWER_URL=http://100.64.0.60:8088/ \
RENDER_API=http://100.64.0.60:8090 \
npm run test:server-performance
```

当前 RX 7700 XT + Tailscale 链路用 1,200 Gaussian 回归夹具实测：修复前 5.43 秒连续拖动仅收到 1 帧（0.2 FPS、E2E 约 3.9 秒）；小夹具可稳定超过 20 FPS。2026-10-31 用 **1,000,000 Gaussian 全量点集**连续拖动，客户端发送 312 个最新相机状态、收到 274 帧，测得 25.4 FPS（页面实时值 24 FPS）；松手后的 1280×720 清晰帧 GPU 12 ms、E2E 166 ms。服务端主动覆盖 251 个过期结果而不是让它们排队。测试脚本默认 **20 FPS** 下限适用于传输回归；百万点跨 Tailscale 的实际结果仍会随链路吞吐变化。

2026-10-31 规模基准（确定性城市体，持续环绕相机；浏览器视口 1280×720）：

| Gaussian 数 | 浏览器本地（GTX 1650 Ti） | RX 7700 XT 服务端 800×450 | 服务端峰值分配 |
|---:|---:|---:|---:|
| 100K | 75.0 FPS | 222.0 FPS / 4.5 ms | 25.6 MiB |
| 500K | 74.7 FPS | 126.7 FPS / 7.9 ms | 90.9 MiB |
| 1M | 73.5–74.2 FPS（3 次） | 78.1 FPS / 12.8 ms | 182.5 MiB |
| 2M | 71.6 FPS（加载 7.9 s） | — | — |

这组数据说明百万点不应默认走远程逐帧 JPEG：本地 GPU 已能稳定交互，而且没有 RTT/带宽成本。当前 gsplat HIP/RDNA3 组合还有一个反直觉特征：1M 全量点在 256×144 为 27.9 FPS，在 512×288、640×360、800×450 分别为 57.6、73.4、约 78 FPS；进一步降到 192×108 反而只有约 18–21 FPS，因此最低档保持 256×144。当前慢速 Tailscale 上，旧同步发送路径的 512×288（约 3.4 KiB/帧）在线仅 6.5 FPS、E2E 约 2.76 秒；latest-frame 路径在同一 1M 模型最终测得 25.4 FPS，且不再积压旧视角。要稳定更高帧率仍应使用浏览器本地/分页模型流或更换局域网链路，逐帧 JPEG 的极限受实际带宽和丢包影响。

若页面只有 1 FPS，先看 `GPU xx ms` 和 `E2E xx ms`：GPU 约 10–30 ms、E2E 却数百到数千毫秒，说明驱动和 ROCm 正常，瓶颈位于传输。可分别检查延迟和 32 KiB 实际吞吐：

```bash
tailscale ping 100.64.0.60
curl -o /dev/null -sS -w 'connect=%{time_connect}s total=%{time_total}s size=%{size_download}\n' \
  http://100.64.0.60:8088/assets/<当前构建的-js-文件>
```

Tailscale 显示 `direct` 只表示未走 DERP，不保证 Wi-Fi/校园网吞吐。32 KiB 仍需数秒时，JPEG 流不可能达到实时视频帧率；优先改用稳定有线网络、同局域网地址或 SSH 单端口转发，并确认两端 MTU/丢包。页面的 FPS 在连续帧到达时显示实际流帧率；相机空闲后的单张清晰帧不会把整段空闲时间误报成 1 FPS。

## 4. 前后端联调与访问

浏览器页面右上角可切换“本地渲染 / 大场景流式 / 服务端渲染”。本地模式读取用户文件；大场景模式只按需 GET 远程 `.RAD/.RADC` 分块；切换到服务端后，标准 PLY 才会上传到 API。源码默认部署中查看器位于 `8088`、GPU API 位于同主机 `8090`，前端会自动推导该地址；反向代理部署仍可用 `window.LUMA_RENDER_API` 指定同源 API。

服务端交互使用不锁定俯仰角的连续相机基，可纵向越过天顶/天底并完成水平、纵向 360° 旋转。键盘 `W/S` 前后、`A/D` 左右、`E/Q` 上下，方向键兼容前后左右；鼠标右键拖动为屏幕平移，滚轮或 `+/-` 为 zoom in/out，`R` 重置。页面左下导航盘提供同样的六方向和缩放按钮。

推荐的 A5000 单端口部署：

- 页面、API、WebSocket 和 MJPEG：服务器 `8089`
- Tailscale 直连：`http://100.64.0.60:8089/`
- SSH 转发后的本机地址：`http://127.0.0.1:18089/`

能访问 Tailscale 地址时优先直连，可少一层 SSH 转发。若端口不可直达，在用户设备建立单端口隧道；无需删除或重建 Docker：

```bash
ssh -N -L 18089:127.0.0.1:8089 A5000-tailscale-ljq
```

随后打开 `http://127.0.0.1:18089/`。一个端口已经足够，因为 `server_render_api.py --site-dir ...` 同时提供静态页面、REST API 和 WebSocket Upgrade。只有把 Vite 静态站点与 GPU API 分开运行时才需要两个端口；跨域部署还需正确代理 `/api/session/*/ws` 的 Upgrade 头。

旧 V100 容器若仍采用前端 `8088`、API `8090` 的分离部署，可继续使用双端口转发：

```bash
ssh -N -p 2223 \
  -L 18088:127.0.0.1:8088 \
  -L 18090:127.0.0.1:8090 \
  root@100.64.0.24
```

生产环境应使用同域名 HTTPS/WSS，并增加鉴权、限流和上传审计。

### 人工启动 / 停止命令

一键命令（A5000 部署，`/home/ljq/luma/run.sh` 为部署环境自带，不在仓库内；可从任意已配置 SSH 的机器直接粘贴执行）：

```bash
# 启动空查看器（不预载模型，网页中再上传，后台常驻，端口 8089）
ssh A5000-tailscale-ljq 'cd /home/ljq/luma && bash run.sh start'

# 可选：确实需要启动即加载时，才显式指定模型
ssh A5000-tailscale-ljq 'cd /home/ljq/luma && MODEL_PATH=/absolute/path/model.ply bash run.sh start'

# 停止 / 查看状态
ssh A5000-tailscale-ljq 'bash /home/ljq/luma/run.sh stop'
ssh A5000-tailscale-ljq 'bash /home/ljq/luma/run.sh status'
```

没有 `run.sh` 时，等价的手工命令（在部署机上直接执行，效果与上面一致）：

```bash
cd /home/ljq/luma/luma-stream-render-v2
MODEL_PATH=/absolute/path/to/model.ply \
LUMA_PYTHON=/home/ljq/miniconda3/envs/luma/bin/python3 \
MEMORY_FRACTION=0.25 \
PHYSICAL_GPU=0 \
PORT=8089 \
setsid env PHYSICAL_GPU=0 bash run-web-renderer.sh > logs/server.log 2>&1 &
```

`MEMORY_FRACTION` 是显存占比上限：24G 卡取 `0.25` ≈ 6 GiB，可常驻约 50M SH0 点；共享卡请降回 `0.045`。端口被占时启动器会拒绝启动，不会杀其他进程。优先使用 `run.sh stop` 按 PID 文件校验并停止，不要用宽泛的 `pkill`。


## 5. 模型要求与异常 PLY 修复

浏览器本地模式支持 `.ply`、`.splat`、`.ksplat`、`.spz`。服务端当前只接受标准 binary little-endian 3DGS PLY，至少包含：

```text
x y z
f_dc_0 f_dc_1 f_dc_2
opacity
scale_0 scale_1 scale_2
rot_0 rot_1 rot_2 rot_3
```

标准 3DGS 中 `scale_*` 应为 log-scale，`opacity` 应为 logit。若导出代码错误地保存了激活后的线性值，直接加载可能产生巨大 Gaussian、tile 数暴涨并最终显存溢出。请保留原文件并生成修复副本：

```bash
python3 server/fix_standard_3dgs_ply.py input.ply input_fixed.ply
```

脚本执行 `scale_* = log(scale)`、`opacity = logit(opacity)`，并拒绝覆盖输入文件。仅当确认文件保存的是线性值时使用；不要对正常标准 PLY 重复转换。

## 6. 验证与测试

前端构建：

```bash
cd frontend
npm ci
npm run build
```

浏览器测试需要本机 Chrome/Edge；其他路径可设置 `CHROME_PATH`：

```bash
npm run test:client
VIEWER_URL=http://127.0.0.1:18088 \
RENDER_API=http://127.0.0.1:18090 \
EXPECTED_MODEL=model.ply \
npm run test:server
npm run test:stream    # 快速拖动、背压、松手最终帧延迟
npm run test:mjpeg     # 禁用 WebSocket 后验证自动降级与会话释放
npm run test:local-lod # 本地 PLY -> 浏览器 LoD + 自动分流，不上传服务器

# 生成 100K/500K/1M 基准并测试当前浏览器 GPU
npm run benchmark:generate
npm run benchmark:local

# 在 GPU 服务器本机测试 API（排除网络传输）
python3 ../server/benchmark_api.py tests/generated/benchmark-1000000.ply

# 可选：明确验证高清 100% 或性能 50% 在旋转期间点数恒定
QUALITY=high LOD_PERCENT=100 npm run test:stream
QUALITY=performance LOD_PERCENT=50 npm run test:stream
```

服务端显存探针默认只使用指定 GPU，并在显存余量或利用率不安全时停止增加规模：

```bash
cd server
PHYSICAL_GPU=3 bash ./run-probe.sh
```

## 7. 常见问题

- `npm.ps1 cannot be loaded`：Windows 使用 `npm.cmd`，或由用户自行调整 PowerShell 执行策略。
- `No matching distribution`：确认服务端是 Linux x86_64 + Python 3.10，并使用项目锁定的 `cp310` wheel。
- `CUDA 不可用`：检查 `nvidia-smi`、驱动兼容性以及是否正确设置 `PHYSICAL_GPU`。
- `GPU 剩余显存不足`：换到空闲 GPU、降低模型/分辨率，或等待已有任务结束；不要直接提高上限并挤占其他任务。
- 页面能开但服务端模式离线：检查 `8090/18090` 转发、`/health`、浏览器控制台和 HTTPS 混合内容。
- 页面可用但拖动卡顿：先看指标中的 `render_ms`。它很低但显示帧间隔很大，通常是 RTT、代理未升级 WebSocket 或 JPEG 带宽问题，不是显存不足；确认页面元素 `#serverViewport` 使用 `websocket` 类，并优先直连 Tailscale 单端口。
- PLY 一加载就 OOM：先检查 NaN/Inf、`scale_*` 和 `opacity` 的保存语义，再考虑模型规模。
- `.splat/.ksplat/.spz` 无法上传到服务端：这些格式目前仅由浏览器本地模式支持，服务端需先转换为标准 PLY。

## License

项目代码使用 [MIT License](LICENSE)。第三方前端、PyTorch、gsplat 与 Three.js 的许可说明见 [THIRD_PARTY_NOTICES.md](frontend/THIRD_PARTY_NOTICES.md)。
