# DSH Voice Bridge 接口参考（`dsh-voice-bridge`）

本文件是 `dsh-voice-bridge` DSH Host 插件在 DSH 的 Web 服务（`ctx.webServer`）上
暴露的 HTTP/SSE 接口参考。插件实现见 `dsh-voice-bridge/index.js`（服务端）与
`client.js`（DSH 客户端弹窗）。

> 基地址：DSH 桌面端当前 host 的 loopback 地址，形如
> `http://127.0.0.1:<port>`（端口每次启动随机变化）。由插件运行时管理器拉起的
> Worker 会自动拿到当前端口（`DSH_VOICE_URL` 环境变量注入）。

## 鉴权模型

- 会话类端点（`/voice/sessions`、`/voice/prompt`、`/voice/cancel`、`/voice/follow`）
  要求 `DSH_VOICE_TOKEN` 已配置；未配置时统一返回 `503 voice bridge disabled`。
- 传 token 的方式（二选一）：
  - 请求头 `X-DSH-Voice-Token: <token>`
  - 查询参数 `?token=<token>`（仅对 GET 端点有用，如 `/voice/follow`）
- token 值必须与桌面 profile `cordis.patch.yml` 里 `config.token` 完全一致
  （恒定时间比较，长度不同直接 401）。
- 运行时端点（`/voice/runtime/*`）不做 token 校验，但**只接受 loopback 来源**
  （`127.0.0.1 / ::1 / ::ffff:127.0.0.1`），非本机返回 `403`。
- 服务应保持只绑定 loopback，不要把 host 端口暴露到局域网。

## 会话桥端点

### `GET /voice/health`

无鉴权。返回桥健康与能力列表。

```json
{
  "ok": true,
  "bridge": "livekit-dsh",
  "version": "0.1.0",
  "tokenRequired": true,
  "endpoints": ["/voice/sessions", "/voice/prompt", "/voice/cancel", "/voice/follow",
                "/voice/runtime/status", "/voice/runtime/start", "/voice/runtime/stop"]
}
```

### `GET /voice/sessions`

token。列出对当前 profile 可见的 DSH 会话（`sessionController.list`）。

### `POST /voice/sessions`

token。创建一个隔离的 DSH 会话。

请求体（字段均可选）：

```json
{ "cwd": "F:\\LiveKitVoice", "sessionId": "...", "agentPreset": "cordis" }
```

- `cwd`：会话工作目录（缺省 `process.cwd()`）；
- `agentPreset`：缺省按 DSH 默认；
- 响应 `201`，形如 `{ "sessionId": "session-...", "agentPreset": "cordis" }`。

### `POST /voice/prompt`

token。向指定会话提交一轮用户输入。

```json
{ "sessionId": "session-...", "text": "帮我看下当前目录", "mode": "queue" }
```

- `mode`：`queue`（排队）或 `steer`（转向当前轮），缺省 `queue`；
- `text` 非空且 ≤ 32000 字符；
- 响应 `200`：`{ ..., "requestId": "uuid" }`（透传 DSH `prompt` 结果 + 去重 id）；
- 会话不可用 / 文本非法 → 对应 `4xx`，桥内部错误 → `500`。

### `POST /voice/cancel`

token。取消该会话当前活跃轮次（保留 inbox 中待处理内容）。

```json
{ "sessionId": "session-..." }
```

### `GET /voice/follow?sessionId=...`

token。SSE 流，持续推送该会话的 Session 帧与 assistant 增量。

- 每帧一行 `data: <json>\n\n`；`json` 形如 `{ "type": "frame", "frame": {...} }`
  或 `{ "type": "event", "event": { "type": "turn/end" } }`；
- assistant 增量在 `frame.chunk.type === "text-delta"` 的 `frame.chunk.text`；
- 心跳：每 15s 一行 `: heartbeat` 注释帧；
- 客户端断开即中止上游 follow；客户端读流侧应把 `turn/end` 当作一轮结束。

> Worker（`voice_agent.py` 的 `_DSHLLMStream`）先开 `follow` 再发 `prompt`，
> 顺序不能反，否则会漏掉本轮开头的增量。

## 运行时管理器端点（loopback only）

管理器在 DSH 内监督三条本地进程：`livekit`、`worker`（voice_agent.py）、
`playground`（npm dev）。`start` 是**幂等的 ensure-each-service**：只拉起
缺失/挂掉的项，不重启已健康的项。

### `GET /voice/runtime/status`

返回管理器快照：

```json
{
  "phase": "running",
  "startedAt": 0,
  "lastError": "",
  "playgroundUrl": "http://127.0.0.1:3000/",
  "livekitUrl": "ws://127.0.0.1:7880",
  "processes": [{ "name": "worker", "pid": 1234, "running": true }],
  "logs": [{ "at": 0, "stream": "worker:out", "text": "..." }]
}
```

`logs` 为环形缓冲（上限 200 条，快照返回最近 40 条），`stream` 前缀：
`livekit:out|err`、`worker:out|err`、`playground:out|err`、`<name>:exit`。

### `POST /voice/runtime/start`

loopback。缺什么补什么（端口探活 + 跟踪进程存活双判据）。
若请求来自当前 host（loopback），把请求的 origin 作为 Worker 的
`DSH_VOICE_URL` 注入（跟随随机 host 端口）。Playground 20s 未开端口 → `500`。

### `POST /voice/runtime/stop`

loopback。停止由管理器拉起的进程（Windows 用 `taskkill /T /F`，3s 后 SIGKILL 兜底）。
不触碰外部自启的同名服务。

## 错误约定

| 状态 | 含义 |
| --- | --- |
| 400 | 参数缺失/非法（无 sessionId、空 text、非 JSON 等） |
| 401 | token 缺失或不匹配（会话桥端点） |
| 403 | 非 loopback 访问运行时端点 |
| 405 | 方法不允许 |
| 413 | 请求体超过 64KB / text 超过 32000 字符 |
| 500 | 桥内部错误（含 Playground 20s 未开端口） |
| 503 | 会话桥未配置 `DSH_VOICE_TOKEN` |
