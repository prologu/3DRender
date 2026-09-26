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

服务端使用 GPU 3 和 gsplat 常驻加载标准 3DGS PLY，浏览器只发送轨道相机参数并接收 JPEG 帧：

```bash
cd /workspace/luma-server-render
PHYSICAL_GPU=3 \
MODEL_PATH=/workspace/luma-server-render/models/model.ply \
bash ./run-render-server.sh
```

默认 API 端口为 `8090`，接口包括：

- `GET /api/status`：GPU、运行环境和当前模型状态
- `POST /api/render`：按 yaw、pitch、distance、FOV 和分辨率渲染
- `POST /api/model`：以请求体上传 binary little-endian 标准 3DGS PLY
- `POST /api/session`：创建只保留最新相机状态的交互会话
- `GET /api/session/{id}/stream`：接收 MJPEG 长连接帧流
- `POST /api/session/{id}/camera`：切换 preview / balanced / full LOD 并更新视角

默认 LOD 是 25% / 55% / 100% 的稳定嵌套集合。`MAX_SESSIONS` 默认 4，`SESSION_TTL` 默认 120 秒；空闲会话不持续占用 GPU。

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
