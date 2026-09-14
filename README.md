# 3DRender

面向 Web 的 3D Gaussian Splatting（3DGS）交互式查看器。项目同时提供浏览器本地渲染和 NVIDIA GPU 服务端渲染两种路径：普通模型可直接在浏览器中打开，大模型可由服务端常驻加载并按相机参数返回渲染帧。

## 当前能力

- 浏览器本地渲染：`.ply`、`.splat`、`.ksplat`、`.spz`
- 服务端 GPU 渲染：标准 binary little-endian 3DGS `.ply`
- 文件选择与拖放上传、轨道旋转、滚轮缩放、背景切换、画质切换、截图和全屏
- 服务端采用 PyTorch + CUDA + gsplat，模型常驻显存
- 隔离式依赖安装，不修改系统 Python/CUDA；PyPI 默认使用国内镜像
- 提供错误导出 PLY 的修复工具和 GPU 显存基准工具

## 目录

```text
3DRender/
├── frontend/  # Vite + GaussianSplats3D Web 查看器
└── server/    # Python + gsplat 服务端渲染 API
```

模型、上传文件、Python/CUDA 依赖、wheel、日志、PID 和构建产物均不会提交到 Git。

## 浏览器端启动

需要 Node.js 20 或更高版本：

```bash
cd frontend
npm install --registry=https://registry.npmmirror.com
npm run dev
```

打开 Vite 输出的地址。生产构建使用：

```bash
npm run build
```

## 服务端启动

当前已验证环境为 Ubuntu 22.04、Python 3.10、NVIDIA V100、CUDA 11.8。安装脚本默认把依赖放入当前项目的 `server/python/`，不会注册系统服务：

```bash
cd server
APP_ROOT="$PWD" ./setup.sh
PHYSICAL_GPU=3 MODEL_PATH=/absolute/path/model.ply ./run-render-server.sh
```

默认监听 `0.0.0.0:8090`。主要环境变量：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `PHYSICAL_GPU` | `3` | 使用的物理 GPU 编号 |
| `RENDER_PORT` | `8090` | API 端口 |
| `MEMORY_FRACTION` | `0.045` | 当前进程可使用的显存比例 |
| `MIN_FREE_MIB` | `1750` | 发起渲染前要求的最低空闲显存 |
| `MODEL_PATH` | 空 | 启动时预加载的标准 3DGS PLY |

API 包括 `GET /health`、`GET /api/status`、`POST /api/model` 和 `POST /api/render`。当前测试容器未发布端口时，可在访问设备上建立 SSH 转发：

```bash
ssh -N \
  -L 18088:127.0.0.1:8088 \
  -L 18090:127.0.0.1:8090 \
  V100-tailscale-ljq
```

然后访问 `http://127.0.0.1:18088`。

## PLY 参数修复

标准 3DGS PLY 的 `scale_*` 通常保存 log-scale，`opacity` 保存 logit。如果导出代码误把激活后的线性值直接写入这些字段，通用查看器会再次执行 `exp`/`sigmoid`，可能产生极大的投影椭圆并耗尽显存。保留原文件并生成修复副本：

```bash
python server/fix_standard_3dgs_ply.py input.ply input_fixed.ply
```

脚本执行 `scale_* = log(scale)` 和 `opacity = logit(opacity)`，并拒绝覆盖输入文件。

## 当前边界与路线

当前服务端传输完整 JPEG 帧，适合验证功能和显存边界；单进程通过锁串行访问一张 GPU。后续将围绕空间分块、视锥裁剪、屏幕误差 LOD、渐进式加载、帧请求合并、编码管线以及多会话调度继续演进，使千万到亿级 Gaussian 场景不必一次性常驻单卡显存。

## License

本项目自有代码采用 [MIT License](LICENSE)。浏览器渲染依赖及其许可见 [THIRD_PARTY_NOTICES.md](frontend/THIRD_PARTY_NOTICES.md)。PyTorch、gsplat、Three.js 等第三方组件分别遵循其自身许可证。
