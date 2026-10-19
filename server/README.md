# Luma Splat Server Renderer Probe

这是服务端 CUDA 3D Gaussian Splatting 的隔离环境与显存探针。依赖通过 `pip --target` 安装在项目专属的 `python/` 目录，不会修改系统 Python/CUDA，也不会停止服务器现有进程。

完整的前置条件、国内镜像、无外网离线 wheel 下载、前后端联调和故障排查见[项目根目录 README](../README.md)。

## 组成

- PyTorch 2.0.1 + CUDA 11.8（上海交大镜像）
- gsplat 1.5.3 预编译 CUDA wheel
- `render_probe.py`：合成小场景、实际光栅化并记录耗时与显存
- 共享 GPU 保护：默认显存分配上限约 1.47 GiB，余量或利用率异常时自动退出

## 运行

联网安装：

```bash
APP_ROOT="$PWD" bash ./setup.sh
```

无外网容器先在联网设备执行 `bash ./download-wheels.sh`（Windows 可执行 `./download-wheels.ps1`），上传包含 `wheels/` 的 `server/` 目录后安装：

```bash
OFFLINE=1 APP_ROOT="$PWD" bash ./setup.sh
```

显存探针：

```bash
cd /workspace/luma-server-render
PHYSICAL_GPU=3 bash ./run-probe.sh
```

默认测试 1280×720、10K–1.2M 高斯点。结果写入 `benchmark-result.json`，最后成功场景写入同名 PNG。

## 安全边界

所有文件都位于 `/workspace/luma-server-render`。安装和基准不会注册系统服务，不会修改现有进程，也不会使用其他 GPU；当前 GPU 余量低于 1750 MiB 或利用率超过 35% 时停止增加场景规模。

## 交互式服务端渲染

服务端使用指定 GPU 和 gsplat 常驻加载标准 3DGS PLY，浏览器只发送轨道相机参数并接收 JPEG 帧：

```bash
cd /workspace/luma-server-render
PHYSICAL_GPU=3 \
MODEL_PATH=/workspace/luma-server-render/models/model.ply \
bash ./run-render-server.sh
```
解释器默认取 PATH 中的 `python3`；conda 等隔离部署用 `LUMA_PYTHON=/path/to/python3` 显式指定（脚本不激活任何环境）。

默认 API 端口为 `8090`，接口包括：

- `GET /api/status`：GPU、运行环境和当前模型状态
- `POST /api/render`：按 yaw、pitch、distance、`pan`（世界系平移偏移，前后左右移动，按模型半径×8 截断）、FOV 和分辨率渲染
- `POST /api/model`：以请求体上传 binary little-endian 标准 3DGS PLY
- `POST /api/session`：创建只保留最新相机状态的交互会话
- `GET /api/session/{id}/ws`：首选的双向 WebSocket；文本帧上传相机，二进制帧下传统计 + JPEG
- `GET /api/session/{id}/stream`：接收 MJPEG 长连接帧流
- `POST /api/session/{id}/camera`：切换 preview / balanced / full LOD 并更新视角
- `GET /api/model.splat?frac=0.25`：按重要性前缀导出 32 字节/点的 `.splat` 粗模（前端混合渲染用，单次下载后本地常驻）

默认 LOD 是 25% / 55% / 100% 的稳定嵌套集合。`MAX_SESSIONS` 默认 4，`SESSION_TTL` 默认 120 秒；空闲会话不持续占用 GPU。
WebSocket 是默认低延迟路径：客户端相机消息携带递增 `client_seq`，服务端在对应 JPEG 的统计 JSON 中原样确认；前端最多允许 2 个未确认视角并覆盖尚未发送的旧视角。服务端二进制消息格式为：4 字节大端无符号统计 JSON 长度、UTF-8 JSON、JPEG 字节。帧解码使用 `createImageBitmap` 后原子绘制到 Canvas，解码来不及时只显示最新帧。连接失败会自动回退到下述 MJPEG 接口。
服务端另有自适应帧预算（默认开启）：按每帧实际耗时（渲染+编码）对照 `FRAME_BUDGET_MS`（默认 33 ms ≈ 30fps）自动升降 LOD 比例，客户端请求的档位作为上限，有余量时逐步回升；`AUTO_LOD=false` 禁用。新会话前 3 帧跳过调整，避开显存分配与内核加载的瞬时尖峰。相机静止 100 ms 后 MJPEG 流只补发一次已经编码的 JPEG，用于让 Chromium 提交缓冲中的首帧/最终帧；补发不触发 GPU 渲染，之后不会持续传输。**settle 帧规则**：相机停止时客户端会请求更高档位（如 full），此时若机器上一帧在预算内（或无参考帧），立即按该档渲染——避免静止帧停留在拖动期间的低档（洞洞帧）；低配机器超预算时不升档，防止振荡。
LOD 选点策略：客户端档位决定每帧 Gaussian 预算，**默认按重要性前缀截取**（`不透明度 × 最大尺度²` 排序的稳定前缀，点数 <10K 时自动禁用）。这是经过 A/B 验证的默认：对尺度均匀的表面模型（本测试模型 max_scale≈0.009，重要性≈不透明度），top-N 前缀把表面铺满、无可见空洞。另有实验性空间叶选择（`--spatial-lod`，加载时二分网格分组 1.16M 点 → 4096 叶，每帧视锥裁剪 + 投影尺寸贪心选近处叶 + 时间戳标记法 O(选定点数)），它对近处细节友好但会饿死远处覆盖（表面模型上产生 2.35% 可见洞），**默认关闭**，仅在稀疏物体场景按需开启。
多个交互会话在独立 CUDA stream 上并发渲染（流池大小 = `MAX_SESSIONS`）：渲染路径不再持有全局锁，只有模型加载/更换时才互斥；各会话的 GPU 工作在同卡上重叠执行，无头程阻塞。A5000 实测（1.16M 点、balanced 档、相机 50ms 更新）：单会话 19.6 fps，双会话各 19.3 fps，四会话各 18.9 fps。
**任意方向连续 360° 旋转**：`yaw` 与 `pitch` 均只归一化到一个 `2π` 周期，不设俯仰限制。相机使用解析球面基：`forward=[-sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch)]`、`right=[cos(yaw), 0, sin(yaw)]`，`up` 由对应解析式得到。该基在天顶/天底仍为单位正交基，避免固定世界 up 与叉积在极点退化，因此上下和水平方向都可连续完整旋转。

**前后左右移动（pan）**：`/api/render`、`/api/session`、`/api/session/{id}/camera` 接受 `pan=[x,y,z]`（世界系平移偏移，缺省 `[0,0,0]`），服务端 `center = 模型中心 + pan`，并按模型半径×8 截断，防止移出场景。前端**左键拖动=旋转、右键拖动=移动（屏幕平面平移）**；导航盘/`WASD`/方向键沿连续解析相机基的**屏幕轴**累计 `pan`，步长 `distance×0.02` 随缩放缩放。前端本地预览与服务端 `view_matrix` 使用同一组轴，所以经过任一极点后移动方向仍与画面一致。

**数值 LOD（高斯加载量滑杆）**：`lod` 除接受档位字符串（preview / balanced / full）外，也接受数值（如 `0.5` = 50% 点数），直接作为该帧点数比例上限（clip 到 0.05–1.0）。前端“高斯加载量”滑杆（10%–100%）即下发数值 `lod`，实时选择服务端加载点数比例；服务端自适应 LOD 仍在其之上按帧预算自动降档兜底（大场景满加载效率的双保险）。
**流统计**：WebSocket 统计 JSON 与 MJPEG 帧头 `X-Render-Stats` 都包含 `lod_auto`、`revision`；WebSocket 额外返回 `client_seq` 作为应用层确认。

Docker 未发布端口时，在访问设备建立转发：

```bash
ssh -N -L 18090:127.0.0.1:8090 V100-tailscale-ljq
```

网页从 `http://127.0.0.1:18088` 打开时会自动使用 `http://127.0.0.1:18090` 作为渲染 API。

## 线性参数 PLY 修复

如果导出器把已激活的线性 scale/opacity 直接写入标准字段，可保留原件并生成修复副本：

```bash
python fix_standard_3dgs_ply.py input.ply input_fixed.ply
```

转换为 `scale_* = log(scale)` 与 `opacity = logit(opacity)`；脚本拒绝覆盖输入文件。
