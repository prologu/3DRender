# 3DRender

面向 3D Gaussian Splatting（3DGS）的 Web 查看与服务端渲染项目。项目提供两条互补路径：

| 模式 | 渲染位置 | 支持格式 | 适用场景 |
| --- | --- | --- | --- |
| 浏览器本地渲染 | 用户浏览器 / WebGL 2 | `.ply`、`.splat`、`.ksplat`、`.spz` | 快速查看、无需后端、文件不上传 |
| GPU 服务端渲染 | Linux + NVIDIA GPU + gsplat | 标准 binary little-endian 3DGS `.ply` | 低配置客户端、大模型、统一算力 |

服务端模式优先使用**单条双向 WebSocket**：同一连接上传相机状态、下传统计信息和 JPEG 帧；浏览器不支持或代理阻断 WebSocket 时自动回退 MJPEG。相机状态采用 latest-camera-wins，并以 `client_seq` 帧确认把未确认视角限制为 2 个，慢链路也不会让过期鼠标事件排成长队。网页端发送 `lock_lod=true`，拖动、移动和静止帧严格保持相同的分辨率、JPEG 质量和 Gaussian 集合；不会再为了追求 FPS 在旋转时暗中从 100% 降到 25%/35%，因此几何不会随鼠标按下而消失。性能由“高清/性能”分辨率和“高斯加载量”滑杆显式控制。未锁定 LOD 的 API 客户端仍可使用 `FRAME_BUDGET_MS` 自动调节，空间 LOD 为可选实验项（默认关闭）。

`yaw` 与 `pitch` 均支持连续 360° 轨道旋转；前后端使用在天顶/天底仍良定义的解析相机基。**左键拖动 = 旋转**、**右键拖动 = 屏幕平面移动**、**滚轮 = 缩放**；导航盘和 `WASD`/方向键也沿屏幕轴移动。高斯加载量滑杆实时设置点数比例上限，完整模型常驻 GPU 的硬上限与 out-of-core 路线见 [大规模场景路线](docs/LARGE_SCENES.md)。多个会话使用独立 CUDA stream；客户端混合粗模预览默认关闭，需要时用 `USE_HYBRID_PREVIEW=true` 开启。

## 目录

```text
3DRender/
├─ frontend/                      # Vite + GaussianSplats3D Web UI
│  ├─ src/                        # 页面逻辑与样式
│  ├─ public/                     # 图标和离线示例
│  ├─ tests/                      # 浏览器冒烟测试
│  └─ deploy/run-viewer.sh        # 静态站点启动脚本
├─ server/                        # PyTorch + CUDA + gsplat 服务端
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
| WebSocket 双向低延迟流 | 相机 JSON 与 JPEG 帧复用一条持久连接；二进制帧为 `4-byte stats 长度 + stats JSON + JPEG`。客户端仅保留最新待发视角、最多 2 个未确认序号，并在解码拥塞时只绘制最新帧 | A5000、2,146,592 点、Tailscale 直连：默认高清 1280×720 / 100% Gaussian 交互显示间隔中位 33–35 ms（约 28–31 FPS）；性能 800×450 / 50% 为 28–29 ms（约 34–35 FPS）。旧的逐次 POST 控制链路约 3.3 FPS、帧间隔中位约 250 ms |
| 旋转点集锁定 | 网页端所有会话使用 `lock_lod=true`；旋转帧与静止帧使用完全相同的分辨率、JPEG 质量和滑杆点数。协议统计返回 `interactive`、`lod_locked` 便于自动测试 | 2,146,592 点回归中，连续旋转每一帧均为 2,146,592 点、1280×720；50% 滑杆下每一帧均为 1,073,296 点、800×450，不再出现 100%↔25%/35% 结构跳变 |
| 服务端自适应 LOD | 未设置 `lock_lod=true` 的 API 客户端，帧耗时超过 `FRAME_BUDGET_MS` 时按比例自动降 LOD，客户端档位为上限，有余量逐步回升 | 网页默认锁定点集以保证视觉连续；批处理或自定义客户端可不锁定并选择“帧率优先”的自动 LOD |
| 空闲帧提交 | 相机静止 100 ms 后仅补发一次已编码 JPEG，促使 Chromium 提交首帧/最终帧；不重新调用 GPU 渲染，也不持续传输 | 浏览器静止首帧可见；之后保持空闲，无连续重传 |
| 多会话 CUDA stream 并发 | 移除渲染路径全局锁，每个渲染调用从流池取独立 `torch.cuda.Stream`（池大小 = 会话上限），仅模型加载保留互斥 | 相机 50ms 更新下：单会话 19.6 fps，双会话各 19.3 fps，四会话各 18.9 fps（与单会话持平，无头程阻塞） |
| LOD 选点策略（重要性前缀为默认） | 默认按 `不透明度 × 最大尺度²` 的重要性前缀截取（每个 LOD 都是同一组张量的稳定前缀，质量切换不重排、不建索引缓冲）。实测该模型所有高斯尺度几乎均匀（max_scale≈0.009），重要性≈不透明度，top-N 前缀天然把表面铺满、无可见空洞；空间叶选择（`--spatial-lod`，近处贪心）对这类表面模型会饿死远处覆盖（2.35% 洞），故降为实验项默认关闭 | 25% 预算（960×540）：前缀 290K 点，渲染 8.8 ms（≤33 ms 预算）；恢复后 25% 帧与旧版前缀帧逐像素一致（diff 0.00%），可见像素覆盖率 10.27% |
| 任意方向连续 360° 旋转 | `yaw`、`pitch` 仅做周期归一化，不做俯仰钳位；前后端统一使用解析 `forward/right/up` 基，`right` 不再由 `cross(worldUp, forward)` 求得，因此经过 ±90° 两个极点时不退化、不跳变 | A5000 浏览器实测 2,146,592 点：拖动后 `pitch=1.759 rad`（约 100.8°，已越过旧 ±87° 限制），三个基向量长度均为 1、两两点积约 0；服务端单元测试覆盖两个极点、完整 2π 周期和超大角度 |
| 显式质量控制 | “高清/性能”选择 1280×720 或 800×450；高斯加载量滑杆选择 10%–100% 固定点集。两个设置在旋转期间保持不变 | 用户可在“结构完整”和“高帧率”之间明确选择，服务端不再根据鼠标状态偷偷改变模型 |
| 客户端混合渲染（默认关闭） | 服务端导出 25% 粗模（`GET /api/model.splat`，32 字节/点），前端叠加画布本地渲染以提供拖动即时反馈。因服务端已可在帧预算内渲染全量点，叠加层只渲染 25% 稀疏点反而产生空洞，故默认关闭（`USE_HYBRID_PREVIEW`，置 true 重新启用） | 默认下拖动直接显示全质量服务端帧（1,160,393 点、15-19 ms）；需要本地即时反馈时开启叠加层（9.3 MB 粗模下载一次） |
| 交互手感 + 前后左右移动 + 高斯加载量滑杆 | ① 旋转前后保持同一固定点集；② 旋转灵敏度按视口尺寸计算（拖满视口高约转 120°）；③ 导航盘和键盘沿相机屏幕轴累计 `pan`，步长随距离缩放；④ 10%–100% 滑杆直接设置固定点数比例 | 旋转、移动、缩放三种操作互不混淆；跨极点移动方向保持一致；降低点数只会在用户调整滑杆时发生 |
| 旋转与移动区分 + 上下反向修复 | ① **左键拖动 = 旋转、右键拖动 = 移动（屏幕平面平移）、滚轮 = 缩放**——鼠标键位明确区分旋转与移动（右键菜单已屏蔽）；② 导航盘（↑↓←→ + 中心停止）与 `WASD`/方向键使用**屏幕轴**（画面上/下/左/右），并与服务端共享同一组连续解析相机基，因此越过天顶/天底后移动方向仍与画面一致；③ `pointercancel` 与 `lostpointercapture` 均会结束拖动，避免鼠标移出窗口后产生“卡住”状态 | 浏览器测试核对：左键拖仅改变 yaw/pitch，右键拖仅改变 pan；越过旧俯仰限制后相机基仍保持正交，导航方向无极点退化 |

未实现项见 [大规模场景路线](docs/LARGE_SCENES.md)：out-of-core 分块流式加载、深度排序缓存、WebRTC/H.264 多用户视频传输。当前 WebSocket 传 JPEG 已解决控制排队，但不是视频编码器，公网高并发仍建议 WebRTC。

## 4. 前后端联调与访问

浏览器页面右上角可切换“本地渲染 / 服务端渲染”。本地渲染时模型不离开设备；切换到服务端后，标准 PLY 才会上传到 API。

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
