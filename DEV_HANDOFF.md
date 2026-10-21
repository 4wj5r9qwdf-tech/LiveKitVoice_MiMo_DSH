# DEV_HANDOFF — 语音伴随插件开发交接

> 给新会话（创造模式 / cordis preset）的交接文档。先读 `README.md`，再读本文件。
> 旧会话（标准模式，插件开发历史）已锁死无法切模式，本会话是新建的创造模式会话。

## 项目一句话

LiveKit 语音 agent（MiMo 耳朵/嘴 + DSH 会话当大脑）+ 一个 DSH 客户端伴随插件
（悬浮大肥鱼立绘 + 气泡 + 锚定设置卡），代码在 `F:\LiveKitVoice`。

## 关键文件

| 文件 | 作用 |
|---|---|
| `dsh-voice-bridge/index.js` | 宿主插件：`/voice/runtime/*`、`/voice/sessions\|prompt\|cancel\|follow`、`/voice/balance.json`、`/voice/avatar.png`、`/voice/sound.mp3`、`/voice/config`（.env 白名单读写）；托管 livekit/worker/playground 三个子进程 |
| `dsh-voice-bridge/client.js` | 客户端插件（`window.__ModuleLoader__.load`）：头部「语音」按钮 + overlay 里的角色/气泡/设置卡 |
| `dsh-voice-bridge/assets/` | voice-avatar.png（鲸鱼娘立绘）、sounds/ya1.mp3、ya2.mp3（按下/松开音效） |
| `voice_agent.py` | LiveKit worker（python，`dev` 命令）；语音参数已支持 .env 覆盖（VOICE_* 键） |
| `agents-playground/src/components/playground/Playground.tsx` | 嵌入 UI；useEffect 每秒 postMessage 上报 `{type:"dsh-voice-status", status, text}` 给 window.parent |
| `.env` | MIMO/LLM 配置（宿主 `/voice/config` 可白名单读写，保存后 `/voice/runtime/restart-worker` 重启 worker 生效） |

插件已安装到 DSH desktop profile（`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@local\`
软链到本目录 `dsh-voice-bridge`）。**宿主/客户端代码改动需要重启 DSH 才生效**（DSH 端口每次重启都变，
以会话 runtime context 里的 Web GUI URL 为准；`GET /voice/health` 验证）。

## 当前状态（2026-10-21 交接时）

已发布到 GitHub（main）：`eb66a52` companion v3（统一设置卡：气泡内容/角色/提醒/语音模型/语音参数/应用/连接/位置）。
**本次提交把未完成的 WIP 也一并入库了**，WIP 内容（磁盘现状）：

### client.js 已完成（未提交 → 本次已提交）
- 设置项：`soundOn / soundVol / pressAnim / micDevice / showTurnCost / snap / flip / balanceAlert / dailyBudget / roles`
- 点击音效（playSound，宿主 /voice/sound.mp3?id=ya1|ya2）、按压回弹（pressing 状态 + 弹性 transform）
- 拖拽吸附边缘（snap）、水平翻转（flip scaleX(-1)）、角色图库（roles 数组 + 导入/选用/删除）
- 气泡「空闲自动收起」：活动（非 idle 状态）/ 新轮消耗 30s 内 / 警示触发 / alwaysBubble 时才展开
- 每轮消耗：轮询 `/dsh-whale/last-turn.json`（复用 dsh-whale-widget 的记账，只含 DSH 会话模型用量），
  seq 递增时气泡显示「本轮 ¥x · N tok」
- 提醒行：余额预警 / 今日预算（触发时气泡强制展开 + ⚠ 行）
- 设置卡新增 .env 区块：语音模型（MIMO_API_KEY 等 6 键）/ 语音参数（VOICE_* 5 键）+「保存并重启语音服务」
  （POST /voice/config → POST /voice/runtime/restart-worker，只重启 worker，livekit/页面不断）
- hooks：`devices`（麦克风设备列表状态）、`iframeRef`、`sendIframeCmd(cmd)`（已向 ref 发 dsh-voice-command）

### 尚未完成（下一步 TODO，按序）
1. **client.js**：`hiddenFrame` 的 iframe 元素加 `ref: iframeRef`（目前 sendIframeCmd 会打空）。
2. **client.js 卡片**：加「音效」组（勾选 点击音效 / 按压动画 + 音量滑杆 soundVol 0-100）
   和「麦克风」组（`<select>` 渲染 devices + 开/关按钮，onChange 发 `{cmd:'set-mic', deviceId}` 并
   `updateSettings({micDevice})`；按钮发 `{cmd:'mic-on'}`/`{cmd:'mic-off'}`）。
3. **Playground.tsx**：
   - status emitter 加 `mic: session.room.localParticipant?.isMicrophoneEnabled?.()`；
   - 上报 `dsh-voice-devices`（enumerateDevices audioinput 列表，连接后 + 定期）；
   - 监听 `dsh-voice-command`（window message）：`set-mic` → `room.setMicrophoneDeviceId(id)`；
     `mic-on/mic-off` → `localParticipant.setMicrophoneEnabled(bool)`。
4. `node --check` 两个 js + `pnpm tsc --noEmit`（agents-playground），提交推送。
5. 让用户重启 DSH，然后逐项验证：点击音效/回弹、气泡空闲收起、每轮消耗行（需要鲸鱼插件在跑，
   没有则静默隐藏）、麦克风切换、.env 保存重启 worker。

### 其他事实
- 麦克风「听不见」事故已定位为用户系统默认设备选错，链路本身没坏。
- 360 杀毒反复隔离 `livekit-server\livekit-server.exe`：可从同目录 `livekit.zip` 重新解出；
  建议把整个文件夹加进 360 信任区。
- 鲸鱼插件（dsh-whale-widget）仍在 desktop profile 里装着（每轮消耗数据源依赖它，暂不能卸载）；
  它自己的余额/音效/图库等其余功能没有搬进语音插件（刻意不搬）。
- 运行时端口：LiveKit 7880（devkey）、playground dev 3000；DSH host 端口随重启变。
- `voice_agent.py` 的 VOICE_* 参数默认值即调校过的推荐值（静音 1.0s / 等待 1.5-4.0s /
  打断 1.5s / TTS 分句 150 字），.env 不填就用这些。

## 创造模式（cordis preset）可用的东西

- skill：`cordis-plugin-development`（插件开发流程）等，位于 DSH 安装
  `@deepseek-ai/dsh-agent-preset/skills/`（已抽到本目录 `_tmp_dsh_skills/` 供参考，勿提交）。
- 工具：`cordis_inspect_list` / `cordis_inspect_query`（API 探查）、`plugin_manager`。
- 规范要点：bundle 的展示清单（locale/icon）要补全；安装结果看 `application`/`warnings` 字段
  判断是否生效，别看日志；替换已装包的 JS 需要 DSH 重启才加载新模块。
