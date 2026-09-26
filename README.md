# 3DRender

面向 3D Gaussian Splatting（3DGS）的 Web 查看与服务端渲染项目。项目提供两条互补路径：

| 模式 | 渲染位置 | 支持格式 | 适用场景 |
| --- | --- | --- | --- |
| 浏览器本地渲染 | 用户浏览器 / WebGL 2 | `.ply`、`.splat`、`.ksplat`、`.spz` | 快速查看、无需后端、文件不上传 |
| GPU 服务端渲染 | Linux + NVIDIA GPU + gsplat | 标准 binary little-endian 3DGS `.ply` | 低配置客户端、大模型、统一算力 |

服务端模式包含 MJPEG 长连接、相机状态合并（latest-camera-wins）以及三层 LOD：客户端档位（preview / balanced / full）控制总量、服务端帧预算按 `FRAME_BUDGET_MS` 自动升降比例、空间 LOD 按屏幕空间误差优先保留近处细节。多个交互会话在独立 CUDA stream 上并发渲染，互不串行；相机静止时不再重复传输旧帧。客户端混合渲染在拖动时用本地粗模（服务端导出的 25% `.splat`）即时预览，服务端高清帧到达即切换。完整模型仍需常驻 GPU；城市级和亿级 Gaussian 的空间分块流式方案见 [大规模场景路线](docs/LARGE_SCENES.md)。

## 目录

```text
3DRender/
├─ frontend/                      # Vite + GaussianSplats3D Web UI
│  ├─ src/                        # 页面逻辑与样式
│  ├─ public/                     # 图标和离线示例
│  ├─ tests/                      # 浏览器冒烟测试
│  └─ deploy/run-viewer.sh        # 静态站点启动脚本
├─ server/                        # PyTorch + CUDA + gsplat 服务端
│  ├─ server_render_api.py        # HTTP / MJPEG 渲染 API
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

脚本会优先使用部署包中的 `deploy/site/`，否则使用源码构建出的 `dist/`；也可通过 `SITE_DIR=/absolute/site` 指定目录。

## 3. GPU 服务端渲染

### 前置条件与固定版本

- Linux x86_64，已验证 Ubuntu 22.04。
- CPython 3.10；预编译 wheel 名称包含 `cp310`，其他 Python 版本不能直接使用。
- NVIDIA 驱动可运行 CUDA 11.8 构建的 PyTorch，先确认 `nvidia-smi` 正常。
- 已验证组合：PyTorch `2.0.1+cu118`、gsplat `1.5.3+pt20cu118`、NumPy `1.26.4`、Pillow `10.4.0`、setuptools `80.10.2`（必须 <81，setuptools 81 移除了渲染路径用到的 `pkg_resources`）；`opencv-python-headless` 可选，个别构建上作为更快的 JPEG 后端（`LUMA_JPEG_BACKEND=opencv`）。
- 依赖安装到 `server/python/`，不修改系统 Python，也不创建或停止系统服务。

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
| `PHYSICAL_GPU` | `3` | 绑定的物理 GPU 编号 |
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
| `SPATIAL_LOD` | `true` | 启用空间 LOD（按视锥 + 屏幕空间误差选叶节点）；`false` 时 LOD 只按重要性前缀截取 |
| `UPLOAD_DIR` | `server/uploads` | 上传文件保存目录 |

显存比例不是模型容量保证。应根据模型 Gaussian 数、分辨率和同卡已有任务保守调整；脚本不会自动结束其他进程。

### API 健康检查

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/api/status
```

主要接口：`POST /api/model`、`POST /api/render`、`POST /api/session`、`POST /api/session/{id}/camera`、`GET /api/session/{id}/stream`、`GET /api/model.splat?frac=0.25`（导出粗模预览）。请求细节见 [技术架构](docs/ARCHITECTURE.md)。

### 性能优化（服务端帧流水线）

当前版本已实现，A5000 部署实测（1.16M Gaussian 场景，960×540，full LOD）：

| 优化 | 行为 | 实测数据 |
| --- | --- | --- |
| 服务端自适应 LOD | 帧耗时超过 `FRAME_BUDGET_MS` 时按比例自动降 LOD，客户端档位为上限，有余量每帧最多回升 15%；新会话前 3 帧跳过调整 | 3 ms 强制预算：full 11.9 ms → 25%（8.5 ms）→ 9%（6.8 ms）→ 5% 地板（稳定 5.5 ms）；默认 33 ms 预算下 full 档 9.7 ms 不变档 |
| 旧帧重传抑制 | 相机静止时 MJPEG 流不再重复传输已渲染的帧 | 空闲流 4 秒仅 1 帧 |
| 多会话 CUDA stream 并发 | 移除渲染路径全局锁，每个渲染调用从流池取独立 `torch.cuda.Stream`（池大小 = 会话上限），仅模型加载保留互斥 | 相机 50ms 更新下：单会话 19.6 fps，双会话各 19.3 fps，四会话各 18.9 fps（与单会话持平，无头程阻塞） |
| 空间 LOD（八叉树叶选择） | 加载时按二分网格（≈512 点/叶，1.16M 点 → 4096 叶）分组，每帧视锥裁剪 + 投影尺寸贪心选择，在客户端 LOD 预算内优先近处细节；纯 numpy <1.5ms，失败自动回退重要性前缀 | 25% 预算（960×540）：选 297K 点，选择 1.05 ms，渲染 10.7 ms；近景自动剔除视外叶（同预算仅 68K 点入栅格化） |
| 客户端混合渲染 | 服务端导出 25% 粗模（`GET /api/model.splat`，32 字节/点），前端叠加画布本地渲染；拖动/缩放时即时显示本地预览，服务端帧到达且停止拖动即淡出；相机参数与服务端 `view_matrix` 同式映射 | 9.3 MB 粗模下载一次；58K 点解析 + 上传 506 ms；拖动期间本地即时反馈（浏览器实测像素差分验证） |

未实现项见 [大规模场景路线](docs/LARGE_SCENES.md)：out-of-core 分块流式加载、深度排序缓存、WebRTC 低延迟传输。

## 4. 前后端联调与访问

浏览器页面右上角可切换“本地渲染 / 服务端渲染”。本地渲染时模型不离开设备；切换到服务端后，标准 PLY 才会上传到 API。

当前测试端口约定：

- 静态查看器：容器内 `8088`
- GPU 渲染 API：容器内 `8090`
- SSH 转发后的本机地址：`18088` 和 `18090`

Docker 容器没有发布端口时无需删除或重建容器。在用户设备建立 SSH 隧道：

```bash
ssh -N \
  -L 18088:127.0.0.1:8088 \
  -L 18090:127.0.0.1:8090 \
  V100-tailscale-ljq
```

没有 SSH config 时：

```bash
ssh -N -p 2223 \
  -L 18088:127.0.0.1:8088 \
  -L 18090:127.0.0.1:8090 \
  root@100.64.0.24
```

随后访问 `http://127.0.0.1:18088`。页面在 `18088` 运行时会自动连接 `18090`；常规部署会连接同一主机的 `8090`。生产环境应通过同域名 HTTPS 反向代理两个服务，并增加鉴权、限流和上传审计。

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
- PLY 一加载就 OOM：先检查 NaN/Inf、`scale_*` 和 `opacity` 的保存语义，再考虑模型规模。
- `.splat/.ksplat/.spz` 无法上传到服务端：这些格式目前仅由浏览器本地模式支持，服务端需先转换为标准 PLY。

## License

项目代码使用 [MIT License](LICENSE)。第三方前端、PyTorch、gsplat 与 Three.js 的许可说明见 [THIRD_PARTY_NOTICES.md](frontend/THIRD_PARTY_NOTICES.md)。
