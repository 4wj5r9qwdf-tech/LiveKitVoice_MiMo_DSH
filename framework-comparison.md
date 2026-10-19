# Open Agent 框架对比与试配建议

调查日期：2026-10-18。结论只基于候选项目自己的 GitHub 仓库、源码、官方文档和官方提交记录；没有引用二手文章或排行榜。

## 先说结论

1. **最值得先并行试配的是 Hermes Agent**：它同时具备原生 Windows 运行、完整语音模式、流式 STT/TTS、打断、终端/文件/代码执行、MCP、自定义 OpenAI 兼容端点。它的语音不是 LiveKit 适配器，而是自己的 CLI/TUI/Desktop/Discord 音频管线。
2. **OpenClaw 是第二候选**：工具、Web Control UI、插件和实时语音能力很完整，但 Node/Gateway/插件配置更多，且官方文档展示的是自己的 voice-call、Discord voice 和 browser realtime，不是 LiveKit。
3. **DeepSeek Harness 更适合作为“代码执行内核”并行验证，不适合作为现成语音前端**：它的 Web UI、工具注册、Bash/PowerShell、subprocess、审批和沙箱文档很扎实；官方 README/文档导航没有确认内置实时语音或 LiveKit。
4. **不要迁移现有的 LiveKit 前端**：当前 `F:\LiveKitVoice\voice_agent.py` 已经把 LiveKit、MiMo ASR/TTS 和 Agnes/OpenAI 兼容 LLM 接在一起。先保留它，把候选 Agent 作为并行后端或工具层验证，能降低回归风险。

## 消歧

| 用户说法 | 已确认的一手项目 | 结论 |
| --- | --- | --- |
| OpenClaw | [`openclaw/openclaw`](https://github.com/openclaw/openclaw) | 是完整个人 Agent/Gateway 项目，MIT。 |
| Hermes | [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) | 仓库 README 明确称 Hermes Agent；这是完整 Agent 运行时，不只是模型。 |
| Hermes 函数调用 | [`NousResearch/Hermes-Function-Calling`](https://github.com/NousResearch/Hermes-Function-Calling) | 这是函数调用示例/推理资源，README 主要演示股票函数和 JSON mode，不是完整语音 Agent 框架。 |
| DeepSeek | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | 这是 DeepSeek 官方 Agent Harness；不是单纯的模型仓库。 |
| “DeepSeek Hermes” | 无法确认 | 没有找到 DeepSeek 官方项目把 DeepSeek Harness 和 Nous Hermes 合并成一个框架；不要把模型名、Hermes 函数调用仓库和 DeepSeek Harness 混为一谈。 |

## 对照表

| 维度 | OpenClaw | Hermes Agent | DeepSeek Harness |
| --- | --- | --- | --- |
| Windows 本地运行 | 原生 Windows 安装器、Windows Hub、PowerShell Gateway/WSL2 均有官方路径；Node 24.16+ 或 26.1+ | 原生 Windows PowerShell 安装，CLI/Gateway/TUI/工具可不经过 WSL；安装器还会准备 Python/Node/PM 工具 | README 直接给 `npx @deepseek-ai/dsh web`；文档有 Bash、PowerShell 和 Windows ACL 沙箱实现，但 README 没有宣称一键原生 Windows 安装 |
| 实时语音/LiveKit | 官方有 Control UI 的 browser realtime/talk mode、Discord realtime voice、voice-call 插件和 realtime voice provider SDK；未发现 LiveKit 专用适配器，无法确认内置 LiveKit | 官方 Voice Mode 支持 CLI/TUI/Desktop 麦克风、TTS、Discord voice、流式 STT 和 barge-in；未发现 LiveKit 专用适配器，无法确认内置 LiveKit | 官方 README/文档导航未找到 voice/audio/LiveKit 模块；无法确认内置实时语音或 LiveKit |
| 工具调用/代码执行 | `exec`、`browser`、`web_search`、`code_execution` 等 typed tools，带工具策略和沙箱 | `terminal`、`read_file`/写文件、`execute_code`、browser、MCP、memory、subagent；支持审批和多种隔离后端 | `ToolDefinition.execute`、Bash/PowerShell、filesystem、PTY、subprocess、approval、sandbox；执行模型很完整 |
| 写代码/执行脚本 | 有 `exec` 和 `code_execution`，适合直接让模型操作工程 | `terminal` 和 `execute_code`；危险命令有审批，Docker/SSH/Modal/Daytona/Vercel 等后端可隔离 | Bash/PowerShell + `argv` 明确的 subprocess；文件效果模式为 read-only/workspace-write/danger-full-access，且有审批 |
| 自定义 OpenAI 兼容 LLM | `models.providers.<id>.baseUrl` + `api: "openai-completions"`，支持自定义 base URL 和模型列表 | 明确支持任意实现 `/v1/chat/completions` 的自定义端点；配置写入 `~/.hermes/config.yaml` 的 `model.base_url` | Custom model API 支持 OpenAI Chat Completions、Responses、Anthropic Messages；可填 base URL、协议、凭证和模型，并处理 `developer`/`max_tokens` 兼容开关 |
| 安装复杂度 | 中高：Node Gateway、Control UI、模型 provider、语音/电话插件分开配置 | 中高：安装器较完整，但语音依赖 PortAudio/ffmpeg，另有 STT/TTS provider 和审批配置 | 中：`npx` Web UI 起步快；源码构建需要 pnpm，当前明确标注 developer preview，可能破坏兼容 |
| 许可证/活跃度 | MIT；官方提交记录在 2026-10-18 仍有提交 | MIT；官方提交记录在 2026-10-18 仍有提交 | MIT；官方提交记录在 2026-10-17 仍有提交 |

## 逐项证据

### OpenClaw

- 仓库 README 说明它是运行在自己设备上的开源助手，支持 Windows、Control UI、Gateway、模型/Agent harness 插件；安装器支持 Windows，npm 包要求 Node 24.16+ 或 26.1+。来源：[README](https://github.com/openclaw/openclaw/blob/main/README.md)。
- Getting Started 明确写出 Windows Hub、PowerShell installer、WSL2 Gateway，以及 `openclaw dashboard` 打开浏览器 Control UI。来源：[Getting started](https://docs.openclaw.ai/start/getting-started)。
- Tools 文档把工具描述为模型可调用的 typed function，示例包括 `exec`、`browser`、`web_search`；还列出 `exec`、`code_execution`、Control UI terminal。来源：[Tools](https://docs.openclaw.ai/tools)。
- Custom providers 文档明确给出 `models.providers.<id>.baseUrl`、`api: "openai-completions"` 的配置形式，例如 `https://studio.example.ts.net/v1`。因此 Agnes/MiMo 这类 OpenAI Chat Completions 端点可以作为自定义 provider 接入。来源：[Custom providers and local runtimes](https://docs.openclaw.ai/concepts/model-providers/custom-providers)。
- 官方 Voice Call 插件文档描述 outbound、multi-turn、full-duplex realtime voice、streaming transcription；Discord 文档描述 realtime voice channels、provider、TTS 和 interruption policy。来源：[Voice call plugin](https://docs.openclaw.ai/plugins/voice-call)、[Discord voice channels](https://docs.openclaw.ai/channels/discord/voice-channels)。
- Control UI 文档的导航包含 `talk mode browser realtime`；provider voice SDK 还声明 `supportsBargeIn`、`handlesInputAudioBargeIn`、`supportsToolCalls`。来源：[Control UI](https://docs.openclaw.ai/web/control-ui)、[Provider voice capabilities](https://docs.openclaw.ai/plugins/sdk-provider-plugins/voice-and-audio)。
- **LiveKit 判断**：官方上述页面展示的是 OpenClaw 自己的 browser/Discord/voice-call transport，没有给出 LiveKit room 或 LiveKit Agents adapter；因此只能说“未确认内置 LiveKit”，不能说它绝对无法接入。

### Hermes Agent

- [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) README 自称 self-improving AI agent，支持任何模型、OpenAI/自定义端点、终端、消息平台、记忆、技能、子代理和脚本 RPC。
- README 明确写有 native Windows PowerShell 安装，不依赖 WSL；安装器会准备 Python、Node、npm、ripgrep、FFmpeg 等工具。来源：[README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)、[Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)。
- Voice Mode 官方文档明确写：CLI/TUI/Desktop 麦克风输入、语音回复、Discord voice channel、`stt.streaming: true` 的流式 STT、逐句 streaming TTS，以及在生成或播放期间可随时 barge-in。来源：[Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode)。
- Voice Mode 也说明本地 Faster-Whisper 可以免 API key 使用，但原生 Windows ARM64 和 Intel macOS 不支持该本地路径；Windows x64 应先按安装器和依赖文档验证。来源：[Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode)。
- Tools 文档列出 terminal、文件读写、`execute_code`、browser、memory、delegation；Security 文档列出危险命令审批、文件写安全、容器隔离和 shell 注入防护。来源：[Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)、[Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)。
- Provider 文档明确写：Hermes Agent 可以使用任何 OpenAI-compatible API endpoint；只要实现 `/v1/chat/completions`，就可以配置 base URL、API key 和模型。来源：[LLM and Model Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)。
- **LiveKit 判断**：官方 Voice Mode 使用自己的 STT/TTS provider 和 Desktop/CLI 音频路径；在官方 README、Voice Mode 和插件文档中未发现 LiveKit room/Agents adapter，无法确认内置 LiveKit。
- 官方仓库 LICENSE 为 MIT；提交 Feed 显示 2026-10-18 仍有提交。来源：[LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)、[Commits](https://github.com/NousResearch/hermes-agent/commits/main.atom)。

### DeepSeek Harness

- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) README 明确称自己是 DeepSeek AI 的开源 Agent Harness，架构为 everything-is-a-plugin；`npx @deepseek-ai/dsh web` 默认打开 `http://127.0.0.1:3080`。README 同时明确标注 developer preview 和可能的 breaking changes。来源：[README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)。
- Tools 文档定义 `ToolDefinition.execute`、模型可见 schema、超时、结果投影和工具执行策略。来源：[Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools)。
- Shell 文档定义 Bash/PowerShell provider；Subprocess 文档明确说明 `argv` 不经过 shell 解释，并处理 stdin/stdout/stderr、超时和进程组终止。来源：[Shell Executor](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/shell)、[Subprocess](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subprocess)。
- Sandbox 文档定义 `read-only`、`workspace-write`、`danger-full-access` 文件效果模式；Approval 文档定义危险命令的人工审批和不可恢复命令阻断。来源：[Sandboxing](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)、[Approvals](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval)。
- 官方 Providers 文档说明 Custom model API 可以填写 Provider ID、base URL、API 协议、凭证和模型；API protocol 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。文档还给出 `compat.supportsDeveloperRole: false`、`compat.maxTokensField: max_tokens` 等兼容开关。来源：[Configure models](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。
- **LiveKit/语音判断**：README 和官方文档导航主要覆盖 Web Client、LLM、工具、shell、subprocess、审批、沙箱；未找到内置实时语音、麦克风、STT/TTS 或 LiveKit 模块，无法确认。
- 官方仓库 LICENSE 为 MIT；提交 Feed 显示 2026-10-17 仍有提交。来源：[LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)、[Commits](https://github.com/deepseek-ai/deepseek-harness/commits/master.atom)。

### Hermes-Function-Calling

[`NousResearch/Hermes-Function-Calling`](https://github.com/NousResearch/Hermes-Function-Calling) README 说明它提供 Hermes Pro 模型的函数调用和 JSON mode 示例，脚本包括 `functioncall.py`、`jsonmode.py`、`functions.py`，默认示例主要围绕股票数据；它可以作为函数调用格式参考，但不是 Windows 语音 Agent 运行时。来源：[README](https://github.com/NousResearch/Hermes-Function-Calling/blob/main/README.md)。

## 对当前项目的影响

当前 `F:\LiveKitVoice\voice_agent.py` 不是“没有工具调用”的状态：

- `AgentSession` 使用 `openai.LLM(... base_url=LLM_BASE_URL ...)`，所以 LLM 可以指向 Agnes 的 OpenAI 兼容端点；MiMo ASR/TTS 仍是自定义 `/chat/completions` 适配器，不是其他框架能直接继承的标准 `/audio/*` provider。[voice_agent.py:557](F:/LiveKitVoice/voice_agent.py:557)
- 已有 `remember_fact`、`recall_memory`、`get_current_time`、`write_code`、`run_script` 五个 function tool。[voice_agent.py:441](F:/LiveKitVoice/voice_agent.py:441)
- `write_code` 只允许写入 `agent_workspace` 内的相对路径。[voice_agent.py:126](F:/LiveKitVoice/voice_agent.py:126)
- `run_script` 只执行 `.py/.js/.mjs`，限制参数类型和 1 到 120 秒超时，输出截断为 12000 字符。[voice_agent.py:495](F:/LiveKitVoice/voice_agent.py:495)
- 但当前子进程会继承完整环境变量，只有工作目录和扩展名限制，没有 OS 级沙箱、命令 allowlist 或人工审批。[voice_agent.py:140](F:/LiveKitVoice/voice_agent.py:140)

所以“写代码、执行脚本”在当前项目里已经具备基础实现；真正缺的是执行隔离、审批、依赖管理、工程级文件编辑和可重复工作流，而不是再找一个模型。

## 建议的试配顺序

### 1. 先做 Hermes Agent 并行实验

理由：原生 Windows、完整 Voice Mode、流式 STT/TTS、barge-in、代码执行、审批、OpenAI-compatible custom endpoint 都在官方文档中出现。

建议只做隔离目录和最小配置：

- `hermes model` 或 `config.yaml` 指向 Agnes 的 `/v1`，模型填 `agnes-2.5-flash`。
- 先用文字会话验证 Agnes 的 tool call 和 `/v1/chat/completions` 兼容性。
- 再启用 `/voice on`，用本地或云端 STT/TTS 验证 Windows 音频依赖。
- 终端/代码执行先启用审批，不直接开放无限制本地 shell。

### 2. 再做 OpenClaw 并行实验

理由：Control UI、browser realtime、Discord voice、typed tools 和 custom OpenAI provider 更丰富，但 Node Gateway 和插件面更大。

建议先只接 Agnes 的 `openai-completions` provider，验证 Control UI 文字和 browser realtime；不要一开始同时迁移 LiveKit、MiMo STT/TTS、电话和 Discord。

### 3. DeepSeek Harness 只做代码执行后端验证

理由：它的工具、PowerShell、subprocess、审批和 sandbox 证据最明确，但没有已确认的语音前端。可以用它验证“模型生成代码 -> 执行 -> 返回结果”的隔离方案，再把结果通过 HTTP/tool bridge 给现有 LiveKit Worker 调用。

## 最终建议

当前项目的最低风险路线是：**保留 LiveKit + MiMo STT/TTS + Agnes 作为语音壳；优先把 Hermes Agent 作为并行 Agent 内核试配；OpenClaw 作为第二个 UI/语音/插件候选；DeepSeek Harness 作为代码执行和审批沙箱的参考实现。**

如果目标是“马上把语音、工具、记忆、代码执行合成一个本地产品”，Hermes Agent 是第一候选；如果目标是“保留现在的 LiveKit 语音链路，只补代码执行和工程能力”，不要整体迁移，直接参考 Hermes/DeepSeek Harness 的审批、沙箱和工具边界，把当前 `write_code`/`run_script` 补强更稳妥。
