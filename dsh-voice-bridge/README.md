# LiveKit Voice Bridge

This bundle exposes a local HTTP/SSE bridge for a LiveKit voice worker and a
small runtime supervisor for the local voice stack. The DSH Client half adds a
`语音` action to each Session header. Starting it launches the local stack and
opens a compact `shell.overlay` popup in DSH itself; the popup embeds the
Playground for the selected Session and does not require opening a separate
browser window or right-side Browser pane.

The popup is a small windowed panel: drag it by the title bar (works in both
expanded and minimized states), resize it from the 28px corner grip or the
bottom edge strip, and minimize it to a 180x44 bar — the embedded Playground
stays mounted, so the LiveKit connection and the in-room agent keep running
while minimized. Position and size persist in `localStorage`. Opening the panel
auto-connects the Playground to the room (the `dshSessionId` query parameter
enables `autoConnect`), so no manual Connect click is needed. See the root
README's popup/interaction sections for details.

The bridge does not move microphone audio into DeepSeek Harness; the voice
worker sends final transcript text and receives assistant stream frames.
DeepSeek Harness owns the model session, tools, approvals, and tool results.

## Endpoints

- `GET /voice/health` returns bridge status.
- `GET /voice/sessions` lists visible Harness sessions.
- `POST /voice/sessions` creates an isolated Harness session.
- `POST /voice/prompt` accepts `{ "sessionId", "text", "mode" }`.
- `POST /voice/cancel` accepts `{ "sessionId" }`.
- `GET /voice/follow?sessionId=...` streams Session and assistant frames as SSE.
- `GET /voice/runtime/status` reports supervisor state.
- `POST /voice/runtime/start` starts missing local services.
- `POST /voice/runtime/stop` stops services started by this plugin.

The runtime endpoints are loopback-only. The existing session bridge endpoints
continue to require `DSH_VOICE_TOKEN`. The runtime start request derives the
current loopback Host origin; the supervisor passes it as the worker's
`DSH_VOICE_URL`, so it follows the random desktop Host port.

The bridge endpoints require the `DSH_VOICE_TOKEN` environment variable to be
set before the Harness starts. Send the same value in the
`X-DSH-Voice-Token` header or `token` query parameter. The server should stay
bound to loopback.

The desktop profile also needs the bridge token in its `cordis.patch.yml`:

```powershell
- id: dsh-voice-bridge
  name: '@local/dsh-voice-bridge'
  config:
    token: dsh-voice-local-8f3c2a91d4e74b6c9a20e5f137bc4a02
```

The worker reads `LLM_PROVIDER=dsh` from `.env`. The Playground receives the
current DSH Session ID in its URL, encodes it into the LiveKit room name, and
the worker reuses that Session for prompts, tools, history, and approvals.

Install or update the bundle through DSH's plugin page, then restart DSH
Desktop. In each Session, use the `语音` header action to start the service
and open the compact voice popup.
