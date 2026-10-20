"""
LiveKit Agents 实时语音对话 — MiMo（小米）全家桶配置

LLM 走 OpenAI 插件（MiMo 的 /chat/completions 是 OpenAI 兼容的，直接能用）
STT/TTS 走自研适配器 MiMoSTT/MiMoTTS，因为 MiMo 的 ASR/TTS 也是
通过 /chat/completions 端点调用（音频 base64 进 content，TTS 文本进
assistant content），不是 OpenAI 原生的 /audio/* 端点。

需要：
  1. MiMo API Key + Base URL（写到 .env）：
     MIMO_API_KEY=tp-...
     MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
  2. LiveKit 服务器（本地已部署在 F:/LiveKitVoice/livekit-server）：
     LIVEKIT_URL=ws://127.0.0.1:7880
     LIVEKIT_API_KEY=devkey
     LIVEKIT_API_SECRET=...

运行：
  python voice_agent.py console    # 终端直接语音对话（麦克风进/扬声器出）
  python voice_agent.py dev        # 启动 Agent 服务器（配浏览器 / Playground）
"""
import base64
import asyncio
import json
import io
import logging
import math
import os
import re
import struct
import subprocess
import sys
import uuid
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    room_io,
    APIConnectOptions,
    APIError,
    DEFAULT_API_CONNECT_OPTIONS,
)
from livekit.agents.stt import (
    STT,
    STTCapabilities,
    SpeechData,
    SpeechEvent,
    SpeechEventType,
)
from livekit.agents.tts import (
    TTS,
    TTSCapabilities,
    ChunkedStream,
    SynthesizedAudio,
)
from livekit.agents.llm import (
    ChatChunk,
    ChatContext,
    ChoiceDelta,
    LLM,
    LLMStream,
)
from livekit.agents.utils import AudioBuffer
from livekit.plugins import openai
import livekit.rtc as rtc

load_dotenv()
logger = logging.getLogger("voice-agent")

# —— MiMo 提供商（OpenAI 兼容）——
MIMO_API_KEY = os.environ.get("MIMO_API_KEY", "sk-your-mimo-key")
MIMO_BASE_URL = os.environ.get(
    "MIMO_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1"
)

# MiMo 模型
MIMO_LLM = "mimo-v2.6-flash"      # 大脑
MIMO_STT = "mimo-v2.5-asr"        # 耳朵
MIMO_TTS = "mimo-v2.5-tts"        # 嘴巴
MIMO_TTS_VOICE = "冰糖"            # 预置音色（中国集群默认冰糖）
MIMO_TTS_SR = 24000               # MiMo TTS 输出采样率

# LLM 可以走 DSH 语音桥，也可以回退到任意 OpenAI 兼容 provider
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "dsh")
LLM_API_KEY = os.environ.get("LLM_API_KEY", MIMO_API_KEY)
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", MIMO_BASE_URL)
LLM_MODEL = os.environ.get("LLM_MODEL", MIMO_LLM)
DSH_VOICE_URL = os.environ.get("DSH_VOICE_URL", "http://127.0.0.1:3081").rstrip("/")
DSH_VOICE_TOKEN = os.environ.get("DSH_VOICE_TOKEN", "")
DSH_VOICE_CWD = os.environ.get("DSH_VOICE_CWD", str(Path(__file__).parent))

MEMORY_FILE = Path(__file__).with_name("memory.json")
MAX_MEMORY_ITEMS = 200
AGENT_WORKSPACE = Path(__file__).with_name("agent_workspace")

# —— 语音行为参数（默认值即调校好的推荐值；可被 .env 覆盖，供伴随设置卡调整）——
def _env_float(name: str, default: float) -> float:
    try:
        raw = os.environ.get(name, "").strip()
        return float(raw) if raw else default
    except ValueError:
        return default

VOICE_VAD_MIN_SILENCE = _env_float("VOICE_VAD_MIN_SILENCE", 1.0)
VOICE_VAD_PREFIX_PADDING = _env_float("VOICE_VAD_PREFIX_PADDING", 0.4)
VOICE_VAD_THRESHOLD = _env_float("VOICE_VAD_THRESHOLD", 0.5)
VOICE_ENDPOINT_MIN_DELAY = _env_float("VOICE_ENDPOINT_MIN_DELAY", 1.5)
VOICE_ENDPOINT_MAX_DELAY = _env_float("VOICE_ENDPOINT_MAX_DELAY", 4.0)
VOICE_INTERRUPT_MIN = _env_float("VOICE_INTERRUPT_MIN", 1.5)
MAX_CODE_OUTPUT_CHARS = 12000
SCRIPT_EXTENSIONS = {
    ".py": ("python", (sys.executable,)),
    ".js": ("node", ("node",)),
    ".mjs": ("node", ("node",)),
}


def _load_memory() -> list[dict[str, Any]]:
    try:
        with MEMORY_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save_memory(items: list[dict[str, Any]]) -> None:
    with MEMORY_FILE.open("w", encoding="utf-8") as f:
        json.dump(items[-MAX_MEMORY_ITEMS:], f, ensure_ascii=False, indent=2)


def _recent_memory_text() -> str:
    items = _load_memory()[-10:]
    if not items:
        return ""
    return "\n".join(f"- {item.get('text', '')}" for item in items)


def _resolve_agent_path(file_name: str) -> Path:
    """将模型提供的相对路径限制在 agent_workspace 内。"""
    relative_path = Path(file_name.strip())
    if not file_name.strip() or relative_path.is_absolute():
        raise ValueError("文件名必须是 agent_workspace 内的相对路径")

    AGENT_WORKSPACE.mkdir(parents=True, exist_ok=True)
    workspace_root = AGENT_WORKSPACE.resolve()
    target = (workspace_root / relative_path).resolve()
    if workspace_root not in target.parents and target != workspace_root:
        raise ValueError("文件路径不能离开 agent_workspace")
    return target


async def _run_process(
    command: tuple[str, ...],
    *,
    cwd: Path,
    timeout_seconds: int,
) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
        },
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        raise TimeoutError(f"脚本执行超过 {timeout_seconds} 秒，已终止")

    return (
        process.returncode or 0,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


def _format_process_output(
    return_code: int,
    stdout: str,
    stderr: str,
) -> str:
    parts = [f"退出码: {return_code}"]
    if stdout.strip():
        parts.append(f"标准输出:\n{stdout.strip()}")
    if stderr.strip():
        parts.append(f"错误输出:\n{stderr.strip()}")
    output = "\n\n".join(parts)
    if len(output) > MAX_CODE_OUTPUT_CHARS:
        output = output[:MAX_CODE_OUTPUT_CHARS] + "\n...输出已截断..."
    return output


def _to_wav(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    """把裸 PCM16 字节封装成带 RIFF 头的 WAV，MiMo ASR 要求 wav/mp3。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class MiMoSTT(STT):
    """通过 MiMo 的 /chat/completions 调 mimo-v2.5-asr（音频 base64 进 content）。"""

    def __init__(self, *, api_key: str, base_url: str, model: str = "mimo-v2.5-asr",
                 language: str = "zh") -> None:
        super().__init__(capabilities=STTCapabilities(streaming=False, interim_results=False))
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._language = language
        # 用共享客户端，不重复建 SSL context

    def label(self) -> str:
        return f"MiMo ASR ({self._model})"

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        return "mimo"

    async def aclose(self) -> None:
        # 共享客户端在进程退出时统一关闭，这里不做事
        pass

    async def _recognize_impl(self, buffer: AudioBuffer, *,
                              language: Any, conn_options: APIConnectOptions) -> SpeechEvent:
        frames = buffer if isinstance(buffer, list) else [buffer]
        if not frames:
            return SpeechEvent(type=SpeechEventType.END_OF_SPEECH, alternatives=[])

        pcm = b"".join(f.data for f in frames)
        sr = frames[0].sample_rate
        ch = frames[0].num_channels

        wav = _to_wav(pcm, sr, ch)
        b64 = base64.b64encode(wav).decode()
        lang = language if isinstance(language, str) and language else self._language

        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio",
                         "input_audio": {"data": f"data:audio/wav;base64,{b64}"}}
                    ],
                }
            ],
            "asr_options": {"language": lang},
        }
        try:
            resp = await _get_mimo_http_client().post(
                self._base_url + "/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            resp.raise_for_status()
            data = resp.json()
            text = ""
            choices = data.get("choices", [])
            if choices:
                msg = choices[0].get("message", {})
                text = msg.get("content") or ""
            alt = SpeechData(language=lang, text=text.strip())
            return SpeechEvent(type=SpeechEventType.FINAL_TRANSCRIPT, alternatives=[alt])
        except httpx.HTTPError as e:
            raise APIError(f"MiMo ASR HTTP {e}", retryable=False) from e


# —— 共享的 httpx 客户端（预热，避免每次请求都 create_ssl_context 卡事件循环）——
_mimo_http_client: httpx.AsyncClient | None = None
_mimo_http_lock = None


def _get_mimo_http_client() -> httpx.AsyncClient:
    global _mimo_http_client, _mimo_http_lock
    if _mimo_http_client is None:
        _mimo_http_client = httpx.AsyncClient(timeout=60.0)
    return _mimo_http_client


async def _aclose_mimo_http_client() -> None:
    global _mimo_http_client
    if _mimo_http_client is not None:
        await _mimo_http_client.aclose()
        _mimo_http_client = None


class _DSHLLMStream(LLMStream):
    """把 DSH 插件的 assistant-stream SSE 转换成 LiveKit ChatChunk。"""

    def __init__(
        self,
        llm: "DSHLLM",
        *,
        chat_ctx: ChatContext,
        text: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(llm, chat_ctx=chat_ctx, tools=[], conn_options=conn_options)
        self._bridge = llm
        self._text = text
        self._finished = False

    async def _run(self) -> None:
        session_id = await self._bridge.ensure_session()
        follow_url = f"{self._bridge.base_url}/voice/follow?sessionId={session_id}"
        try:
            async with self._bridge.client.stream(
                "GET",
                follow_url,
                headers=self._bridge.headers,
            ) as follow:
                follow.raise_for_status()
                prompt = await self._bridge.client.post(
                    f"{self._bridge.base_url}/voice/prompt",
                    headers=self._bridge.headers,
                    json={
                        "sessionId": session_id,
                        "text": self._bridge.format_prompt(self._text),
                        "mode": "queue",
                    },
                    timeout=30.0,
                )
                prompt.raise_for_status()

                async for line in follow.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        payload = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    frame = payload.get("frame") or {}
                    if (
                        payload.get("type") == "event"
                        and (payload.get("event") or {}).get("type") == "turn/end"
                    ):
                        break
                    if frame.get("type") != "chunk":
                        continue
                    chunk = frame.get("chunk") or {}
                    if chunk.get("type") != "text-delta":
                        continue
                    text = chunk.get("text")
                    if not isinstance(text, str) or not text:
                        continue
                    self._event_ch.send_nowait(
                        ChatChunk(
                            id=uuid.uuid4().hex,
                            delta=ChoiceDelta(role="assistant", content=text),
                        )
                    )
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            raise APIError(
                f"DSH voice bridge request failed: {exc}",
                retryable=False,
            ) from exc
        finally:
            self._finished = True

    async def aclose(self) -> None:
        should_cancel = not self._finished
        await super().aclose()
        if should_cancel:
            await self._bridge.cancel()


class DSHLLM(LLM):
    """LiveKit LLM adapter backed by the local DeepSeek Harness voice bridge."""

    def __init__(
        self,
        *,
        base_url: str = DSH_VOICE_URL,
        token: str = DSH_VOICE_TOKEN,
        cwd: str = DSH_VOICE_CWD,
        session_id: str | None = None,
    ) -> None:
        super().__init__()
        if not token:
            raise ValueError("DSH_VOICE_TOKEN is required when LLM_PROVIDER=dsh")
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._cwd = cwd
        self._session_id = session_id.strip() if isinstance(session_id, str) and session_id.strip() else None
        self._session_lock = asyncio.Lock()
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            follow_redirects=True,
        )
        self.headers = {"X-DSH-Voice-Token": token}

    @property
    def model(self) -> str:
        # 仅是 LiveKit 侧的展示标签。DSH 模式下真实大脑模型不固定在本项目：
        # 它跟随 DSH 会话当前 Provider 配置（DSH 设置里换什么模型这里就是什么）。
        return "dsh-session"

    @property
    def provider(self) -> str:
        return "dsh"

    @staticmethod
    def format_prompt(text: str) -> str:
        cleaned = text.strip()
        if cleaned.startswith("请向用户打个招呼"):
            return cleaned
        # 把"干活"和"口头汇报"分开：该调工具就正常调，别因为要口语化就
        # 偷懒不做实事；只有最终给用户听的那段要短、口语、无 Markdown，
        # 因为它会被 TTS 念出来。
        return (
            f"{cleaned}\n\n"
            "如需完成用户的任务，正常调用可用的工具把它做完；"
            "完成后用简短、自然、口语化的中文向用户口头汇报结果，"
            "避免 Markdown、代码块和长列表（这些回复会被语音朗读）。"
        )

    async def ensure_session(self) -> str:
        if self._session_id:
            return self._session_id
        async with self._session_lock:
            if self._session_id:
                return self._session_id
            try:
                response = await self.client.post(
                    f"{self.base_url}/voice/sessions",
                    headers=self.headers,
                    json={"cwd": self._cwd},
                )
                response.raise_for_status()
                data = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise APIError(
                    f"failed to create DSH voice session: {exc}",
                    retryable=False,
                ) from exc
            session_id = data.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise APIError(
                    "DSH voice bridge did not return a sessionId",
                    retryable=False,
                )
            self._session_id = session_id
            return session_id

    async def cancel(self) -> None:
        """Cancel the active DSH turn for this bridge's session."""
        if not self._session_id:
            return
        try:
            response = await self.client.post(
                f"{self.base_url}/voice/cancel",
                headers=self.headers,
                json={"sessionId": self._session_id},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("DSH voice cancel failed: %s", exc)

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools: list[Any] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: Any = None,
        tool_choice: Any = None,
        extra_kwargs: Any = None,
    ) -> LLMStream:
        del tools, parallel_tool_calls, tool_choice, extra_kwargs
        messages = chat_ctx.messages()
        user_text = next(
            (
                message.raw_text_content or ""
                for message in reversed(messages)
                if message.role == "user" and (message.raw_text_content or "").strip()
            ),
            "",
        )
        if not user_text:
            user_text = "请向用户打个招呼，简短问下对方今天怎么样，然后等用户说话。"
        return _DSHLLMStream(
            self,
            chat_ctx=chat_ctx,
            text=user_text,
            conn_options=conn_options,
        )

    async def aclose(self) -> None:
        await super().aclose()
        await self.client.aclose()


def _dsh_session_from_room(room_name: str) -> str | None:
    """Recover the DSH session id from a Playground room name."""
    prefix = "dsh-"
    if not isinstance(room_name, str) or not room_name.startswith(prefix):
        return None
    encoded = room_name[len(prefix):]
    if not encoded:
        return None
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        session_id = raw.decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError):
        return None
    return session_id or None


# MiMo TTS 单次合成的文本上限（按句边界分段，逐段请求再拼接音频）。
# 过长单次请求会被 TTS 侧截断（实测 ~600 字回复只念出前 ~400 字），
# 分段后既绕开限制，又让第一句更早开口。
TTS_CHUNK_LIMIT = int(_env_float("VOICE_TTS_CHUNK_LIMIT", 150))
_TTS_SENTENCE_RE = re.compile(r"(?<=[。！？!?；;…\n])")


def _split_tts_text(text: str, limit: int = TTS_CHUNK_LIMIT) -> list[str]:
    """把长文本按句边界拆成 ≤limit 字符的段；超长句硬切。"""
    text = (text or "").strip()
    if not text:
        return []
    chunks: list[str] = []
    cur = ""
    for part in _TTS_SENTENCE_RE.split(text):
        part = part.strip()
        if not part:
            continue
        if len(cur) + len(part) <= limit:
            cur += part
            continue
        if cur:
            chunks.append(cur)
            cur = ""
        while len(part) > limit:
            chunks.append(part[:limit])
            part = part[limit:]
        cur = part
    if cur:
        chunks.append(cur)
    return chunks


class _MiMoTTSChunkedStream(ChunkedStream):
    """MiMo TTS 的 ChunkedStream：调 /chat/completions 流式拿 base64 音频分片，切成 AudioFrame。

    长回复会按句边界拆成多段（TTS_CHUNK_LIMIT 内）逐段合成再顺序拼接：
    既避免单次请求过长被 TTS 侧截断，也让第一句更早出声。
    """

    def __init__(self, tts: TTS, input_text: str, conn_options: APIConnectOptions,
                 api_key: str, base_url: str, model: str, voice: str,
                 sample_rate: int, channels: int, request_id: str) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._voice = voice
        self._sr = sample_rate
        self._ch = channels
        self._request_id = request_id

    async def _run(self, output_emitter: Any) -> None:
        chunks = _split_tts_text(self._input_text)
        if not chunks:
            logger.warning("MiMo TTS 输入文本为空")
            return
        client = _get_mimo_http_client()
        sr, sw, ch = 24000, 2, 1          # MiMo pcm16 输出参数
        frame_bytes = int(sr * 0.02 * ch * sw)   # 20ms 一帧
        prime_bytes = int(sr * 0.20 * ch * sw)   # 先缓冲 200ms，减少下游断流
        pcm_buf = bytearray()
        started = False

        def drain(*, final: bool = False) -> None:
            nonlocal started
            if not started and not final and len(pcm_buf) < prime_bytes:
                return

            while len(pcm_buf) >= frame_bytes:
                if not started:
                    output_emitter.initialize(request_id=self._request_id,
                                              sample_rate=sr, num_channels=ch,
                                              mime_type="audio/pcm",
                                              frame_size_ms=20)
                    started = True
                c = bytes(pcm_buf[:frame_bytes])
                del pcm_buf[:frame_bytes]
                output_emitter.push_frame(rtc.AudioFrame(
                    data=c, sample_rate=sr, num_channels=ch,
                    samples_per_channel=frame_bytes // (ch * sw)))

            if final and pcm_buf:
                if not started:
                    output_emitter.initialize(request_id=self._request_id,
                                              sample_rate=sr, num_channels=ch,
                                              mime_type="audio/pcm",
                                              frame_size_ms=20)
                    started = True
                c = bytes(pcm_buf)
                pcm_buf.clear()
                output_emitter.push_frame(rtc.AudioFrame(
                    data=c, sample_rate=sr, num_channels=ch,
                    samples_per_channel=len(c) // (ch * sw)))

        for index, chunk in enumerate(chunks):
            p = {"model": self._model, "messages": [
                {"role": "user", "content": "Read the text in a friendly natural tone."},
                {"role": "assistant", "content": chunk}],
                "audio": {"voice": self._voice, "format": "pcm16"},
                "stream": True}
            try:
                async with client.stream("POST", self._base_url + "/chat/completions",
                                         json=p,
                                         headers={"Authorization": "Bearer " + self._api_key}) as r:
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        s = line[5:].strip()
                        if s == "[DONE]":
                            break
                        try:
                            d = json.loads(s)
                        except Exception:
                            continue
                        for c2 in d.get("choices", []):
                            a = (c2.get("delta") or {}).get("audio")
                            if isinstance(a, dict) and a.get("data"):
                                pcm_buf.extend(base64.b64decode(a["data"]))
                                drain()
            except httpx.HTTPError as e:
                logger.warning("MiMo TTS chunk %d/%d failed: %s", index + 1, len(chunks), e)
                continue

        drain(final=True)
        if not started:
            logger.warning("MiMo TTS returned no audio data")

class MiMoTTS(TTS):
    """通过 MiMo 的 /chat/completions 调 mimo-v2.5-tts（文本进 assistant content）。"""

    def __init__(self, *, api_key: str, base_url: str, model: str = "mimo-v2.5-tts",
                 voice: str = "冰糖", sample_rate: int = MIMO_TTS_SR, num_channels: int = 1) -> None:
        super().__init__(
            capabilities=TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=num_channels,
        )
        self._api_key = api_key
        self._base_url = base_url
        self._model = model
        self._voice = voice

    def label(self) -> str:
        return f"MiMo TTS ({self._model})"

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        return "mimo"

    def synthesize(self, text: str, *,
                   conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> ChunkedStream:
        rid = uuid.uuid4().hex[:12]
        return _MiMoTTSChunkedStream(
            tts=self, input_text=text, conn_options=conn_options,
            api_key=self._api_key, base_url=self._base_url, model=self._model,
            voice=self._voice, sample_rate=self.sample_rate,
            channels=self.num_channels, request_id=rid,
        )


# —— Agent ——
class MyAgent(Agent):
    def __init__(self) -> None:
        recent_memory = _recent_memory_text()
        memory_prompt = (
            "\n\n最近的本地记忆：\n" + recent_memory
            if recent_memory
            else ""
        )
        super().__init__(
            instructions=(
                "你是小语，一个友好的中文语音助手。"
                "回答简洁自然，像聊天一样，避免长篇大论和 emoji、markdown、星号等特殊符号。"
                "使用与用户相同的语言。"
                "当用户提供重要、长期有用的信息时，调用 remember_fact 保存；"
                "需要回忆之前的信息时，调用 recall_memory；"
                "需要当前时间时，调用 get_current_time。"
                "用户明确要求编写代码或程序时，先调用 write_code 保存文件；"
                "需要运行 Python 或 Node 脚本时，调用 run_script，并用简洁中文说明结果或错误。"
                "不得声称执行了没有实际调用工具的代码。"
                f"{memory_prompt}"
            ),
        )

    @function_tool
    async def remember_fact(self, fact: str) -> str:
        """记住一条对后续对话有用的长期信息。

        Args:
            fact: 需要记住的信息，例如用户的偏好、名称、计划或重要约定。
        """
        text = fact.strip()
        if not text:
            return "没有可记住的内容"
        items = _load_memory()
        items.append({
            "text": text[:500],
            "created_at": datetime.now().isoformat(timespec="seconds"),
        })
        _save_memory(items)
        return "已记住"

    @function_tool
    async def recall_memory(self, query: str = "") -> str:
        """查询本地长期记忆。

        Args:
            query: 可选的关键词；为空时返回最近的记忆。
        """
        items = _load_memory()
        if query.strip():
            keyword = query.strip().lower()
            items = [item for item in items if keyword in str(item.get("text", "")).lower()]
        if not items:
            return "没有找到相关记忆"
        return "\n".join(f"- {item.get('text', '')}" for item in items[-10:])

    @function_tool
    async def get_current_time(self) -> str:
        """返回本机当前时间。"""
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    @function_tool
    async def write_code(self, file_name: str, code: str) -> str:
        """将代码或文本写入 agent_workspace。

        Args:
            file_name: agent_workspace 内的相对文件名，例如 hello.py 或 report.md。
            code: 要写入文件的完整内容。
        """
        try:
            target = _resolve_agent_path(file_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(code, encoding="utf-8")
        except (OSError, ValueError) as exc:
            return f"写入失败: {exc}"
        return f"已写入 {file_name.strip()}"

    @function_tool
    async def run_script(
        self,
        file_name: str,
        arguments_json: str = "[]",
        timeout_seconds: int = 30,
    ) -> str:
        """执行 agent_workspace 内的 Python 或 Node 脚本。

        Args:
            file_name: agent_workspace 内的 .py、.js 或 .mjs 文件名。
            arguments_json: 传给脚本的 JSON 字符串数组，例如 ["input.txt", "5"]。
            timeout_seconds: 最长执行秒数，范围 1 到 120。
        """
        try:
            target = _resolve_agent_path(file_name)
            extension = target.suffix.lower()
            runtime = SCRIPT_EXTENSIONS.get(extension)
            if runtime is None:
                return "只支持执行 .py、.js、.mjs 脚本"
            if not target.is_file():
                return f"脚本不存在: {target}"

            try:
                script_arguments = json.loads(arguments_json or "[]")
            except json.JSONDecodeError:
                return "arguments_json 必须是 JSON 字符串数组"
            if not isinstance(script_arguments, list) or not all(
                isinstance(item, (str, int, float, bool)) for item in script_arguments
            ):
                return "arguments_json 只能包含字符串、数字、布尔值"

            timeout_seconds = max(1, min(int(timeout_seconds), 120))
            _, interpreter_command = runtime
            command = (
                *interpreter_command,
                str(target),
                *(str(item) for item in script_arguments),
            )
            return_code, stdout, stderr = await _run_process(
                command,
                cwd=target.parent,
                timeout_seconds=timeout_seconds,
            )
            return _format_process_output(return_code, stdout, stderr)
        except (OSError, ValueError, subprocess.SubprocessError, TimeoutError) as exc:
            return f"脚本执行失败: {exc}"

    async def on_enter(self) -> None:
        self.session.generate_reply(
            instructions="向用户打个招呼，简短问下对方今天怎么样，然后等用户说话。"
        )


class VoiceBridgeAgent(Agent):
    """DSH 模式下不注册本地工具，工具和审批完全由 DSH Session 管理。"""

    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "你是小语，一个友好的中文语音助手。"
                "回答简洁自然，像聊天一样，避免长篇大论和特殊符号。"
            ),
        )

    async def on_enter(self) -> None:
        self.session.generate_reply(
            user_input="请向用户打个招呼，简短问下对方今天怎么样，然后等用户说话。",
        )


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    use_dsh = LLM_PROVIDER.strip().lower() in {"dsh", "dsh-voice", "deepseek-harness"}
    dsh_session_id = _dsh_session_from_room(ctx.room.name)
    llm = (
        DSHLLM(session_id=dsh_session_id)
        if use_dsh
        else openai.LLM(
            model=LLM_MODEL,
            api_key=LLM_API_KEY,
            base_url=LLM_BASE_URL,
            reasoning_effort="none",
        )
    )

    session: AgentSession = AgentSession(
        llm=llm,
        # STT（耳朵）：MiMo 自研适配器
        stt=MiMoSTT(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL, model=MIMO_STT, language="zh"),
        # TTS（嘴巴）：MiMo 自研适配器
        tts=MiMoTTS(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL, model=MIMO_TTS, voice=MIMO_TTS_VOICE),
        # 用 VAD 控制“说完”的边界。容忍值偏大，目的是让正常语速的长段落
        # （句间停顿 1s 以内）被当成一整句话完整送进非流式 ASR，而不是被
        # 切碎成多段、前面的段又被打断/取消而丢失。代价是说完后反应稍慢
        # （约多 1s 才起回复）。
        vad=inference.VAD(
            model="silero",
            activation_threshold=VOICE_VAD_THRESHOLD,
            min_silence_duration=VOICE_VAD_MIN_SILENCE,
            prefix_padding_duration=VOICE_VAD_PREFIX_PADDING,
        ),
        turn_handling=TurnHandlingOptions(
            turn_detection="vad",
            endpointing={
                # 检测到说完后继续等：用户在 max_delay 内继续说话就并入本轮，
                # 整段话一次转写。
                "mode": "fixed",
                "min_delay": VOICE_ENDPOINT_MIN_DELAY,
                "max_delay": VOICE_ENDPOINT_MAX_DELAY,
            },
            interruption={
                "mode": "vad",
                # 打断阈值 1.5s：单个「嗯/哦/对」这类短附和（通常 <1.2s）
                # 不再打断长播报；用户真正要插话（连说 1.5s+）才打断。
                # 可被 .env 的 VOICE_INTERRUPT_MIN 覆盖（伴随设置卡可改）。
                "min_duration": VOICE_INTERRUPT_MIN,
                "resume_false_interruption": True,
                "false_interruption_timeout": 2.0,
                "backchannel_boundary": (1.0, 1.5),
            },
            preemptive_generation={"enabled": False},
        ),
        aec_warmup_duration=3.0,
    )

    await session.start(
        agent=VoiceBridgeAgent() if use_dsh else MyAgent(),
        room=ctx.room,
        room_options=room_io.RoomOptions(),
    )


if __name__ == "__main__":
    cli.run_app(server)
