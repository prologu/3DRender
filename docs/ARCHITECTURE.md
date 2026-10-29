# 技术架构

## 三条渲染路径

```mermaid
flowchart LR
    U["浏览器用户"] --> UI["Vite Web UI"]
    UI -->|"本地文件"| W["GaussianSplats3D / WebGL 2"]
    UI -->|".RAD 索引 + 按视角 .RADC"| L["Spark Paged LoD / WebGL 2"]
    L --> Q["共享 LRU page pool（固定显存预算）"]
    UI -->|"相机状态"| S["会话 API"]
    S --> C["latest-camera 合并"]
    C --> G["gsplat / CUDA"]
    G --> J["Pillow JPEG 编码"]
    J -->|"WebSocket JPEG（首选） / MJPEG（降级）"| UI
    UI -->|"PLY 分块上传"| P["磁盘文件 + 校验"]
    P --> M["CPU 解析 / 稳定 LOD 排序"]
    M --> G
```

浏览器本地模式支持 `.ply`、`.splat`、`.ksplat` 和 `.spz`，文件不离开用户设备。分页模式使用 Spark 2.4 读取预构建 `.RAD` LoD 树，按当前相机并行拉取 `.RADC` chunk，LRU 驱逐不再需要的 page，因此场景总 Gaussian 数不受单机显存容量直接限制。服务端模式目前接收标准 binary little-endian 3DGS PLY；服务进程解析并验证参数，把模型常驻一张指定 NVIDIA GPU，由 gsplat 完成光栅化。

## 服务端帧流

客户端创建 `/api/session` 后优先升级到双向 WebSocket：文本消息发送相机状态，二进制消息接收 `stats + JPEG`。相机消息带递增 `client_seq`，服务端随渲染帧确认；浏览器最多保留 2 个未确认视角，待发状态始终覆盖为最新值。这样既避免逐请求 RTT，又避免有序 TCP 中积压过期视角。WebSocket 不可用时回退到 `multipart/x-mixed-replace` MJPEG，并通过 POST 更新相机。

两种协议都只领取最新 revision。GPU 调用本身不能中途取消，但返回后会在发送前再次比较当前 revision：过期结果计入 `dropped_frames`，不会进入 TCP、JPEG 解码或 Canvas。交互请求降低 JPEG 质量以减小传输，停止后补一张高质量帧。浏览器用 `client_seq` 的发送时间与帧确认计算 E2E 时延。MJPEG 在停止后仅补发一次已编码帧以提交 Chromium 缓冲，并探测空闲 socket 断开；WebSocket 不需要重复帧。默认最多 4 个会话、120 秒无流连接自动回收。各渲染调用从 CUDA stream 池取独立 stream，只有模型加载/更换持有全局互斥。

## 浏览器分页 LoD

- `paged-viewer.js` 仅在用户进入“大场景流式”后动态导入；普通首页、服务端模式不会下载约 1 MiB gzip 的 Spark chunk。
- `.RAD/.RADC` 使用三条后台 fetch worker；根 LoD 先显示，细节按当前投影收益逐步细化。
- page pool 默认桌面高清约 8M、桌面性能约 4M，移动设备为 4M/2M；`LUMA_MAX_PAGED_SPLATS` 可覆盖。
- 高清模式 DPR 上限为 1.5，性能模式 DPR=1 并降低 LoD 目标；静止后采用按需渲染，分页队列忙时持续驱动，避免前台空转。
- 由于 paged RAD 初始化完成时完整包围盒尚不可用，查看器等待第一个粗层 chunk 后只拟合一次相机，不跟随不断变化的 resident-cache bounds。

## 当前 LOD

模型加载时使用 `opacity × max(scale)²` 作为与视角无关的重要性近似，只排序一次。三个 LOD 是同一数组的稳定前缀：

- `preview`：25%，供 API 客户端或高斯加载量滑杆选择。
- `balanced`：55%，供 API 客户端选择。
- `full`：100%，网页滑杆默认值。

网页请求使用 `lock_lod=true`：高清模式在旋转和静止时都使用 1280×720，性能模式都使用 800×450；Gaussian 数始终等于 10%–100% 滑杆的明确选择。服务端不得根据 `interactive` 改变点集。未锁定 LOD 的自定义 API 客户端仍可使用帧预算自动升降档。

稳定前缀避免 LOD 切换时随机闪烁，也避免每帧生成 GPU 索引数组。它能减少光栅工作集和传输带宽，但不会减少完整模型的常驻显存，这是它与空间流式 LOD 的关键区别。

## 负载控制

- `CUDA_VISIBLE_DEVICES` 固定物理 GPU，避免误用其他卡。
- `torch.cuda.set_per_process_memory_fraction` 设置进程上限。
- 加载和渲染前检查剩余显存；捕获 CUDA OOM 并清理缓存。
- PLY 校验长度、字段、有限值和尺度语义，阻止异常 Gaussian 放大 tile buffer。
- 会话数有硬上限，所有相机 JSON 和上传文件均有限制。
- 上传以 4 MiB 块写盘，不在 HTTP 层复制整个文件。
- 两个浏览器渲染器均动态导入，服务端模式首屏只下载 UI 主包。

## 部署边界

当前 HTTP 服务采用 Python 标准库，适合隔离容器内验证。公网部署应在它前面增加 TLS 反向代理、认证、上传限速、请求体限制和审计；当前 `Access-Control-Allow-Origin: *` 与无鉴权配置仅适用于受控测试网络。

每个 GPU 建议运行一个渲染 worker，由独立调度层做会话亲和性和 admission control。不要简单增加同卡 worker 数量：每个 CUDA 进程都有上下文开销，且并发光栅化可能造成尾延迟和 OOM。

## API 摘要

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health`, `/api/status` | GPU、模型、能力与会话状态 |
| POST | `/api/model` | 原始请求体上传标准 PLY |
| POST | `/api/render` | 单次 JPEG 渲染，兼容与高清截图 |
| POST | `/api/session` | 创建交互会话并提交初始相机 |
| GET | `/api/session/{id}/ws` | 双向 WebSocket 相机控制与 JPEG 帧流 |
| POST | `/api/session/{id}/camera` | 更新最新相机、分辨率和 LOD |
| GET | `/api/session/{id}/stream` | MJPEG 帧流 |
| GET | `/api/session/{id}` | 最近一帧指标 |
| DELETE | `/api/session/{id}` | 主动释放会话 |
