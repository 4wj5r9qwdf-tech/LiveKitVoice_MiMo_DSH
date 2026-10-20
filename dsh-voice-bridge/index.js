import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const name = "dsh-voice-bridge";
export const inject = ["webServer", "sessionController"];

const MAX_BODY_BYTES = 64 * 1024;
const FLOW_CONTROL_BYTES = 1024;
const RUNTIME_LOG_LIMIT = 200;
// Avatar (merged from dsh-whale-widget's "big fat fish" role image): served by
// GET /voice/avatar.png. Lives in the plugin's own assets/ folder so the
// client popup can display it without any external dependency.
const AVATAR_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "assets",
  "voice-avatar.png",
);

function defaultRuntimeConfig(config = {}) {
  return {
    projectRoot: resolve(config.projectRoot || "F:/LiveKitVoice"),
    livekitServer: resolve(config.livekitServer || "F:/LiveKitVoice/livekit-server/livekit-server.exe"),
    livekitConfig: resolve(config.livekitConfig || "F:/LiveKitVoice/livekit-server/config.yml"),
    python: resolve(config.python || "F:/LiveKitVoice/.venv/Scripts/python.exe"),
    worker: resolve(config.worker || "F:/LiveKitVoice/voice_agent.py"),
    playground: resolve(config.playground || "F:/LiveKitVoice/agents-playground"),
    playgroundUrl: config.playgroundUrl || "http://127.0.0.1:3000/",
    livekitPort: Number(config.livekitPort || 7880),
    playgroundPort: Number(config.playgroundPort || 3000),
    npmCommand: config.npmCommand || "C:/Program Files/nodejs/npm.cmd",
  };
}

function waitForPort(port, timeoutMs = 10_000) {
  return new Promise((resolvePort) => {
    const started = Date.now();
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (open) => {
        socket.removeAllListeners();
        socket.destroy();
        if (open || Date.now() - started >= timeoutMs) resolvePort(open);
        else setTimeout(attempt, 250);
      };
      socket.setTimeout(500);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    };
    attempt();
  });
}

function readLoopbackBaseUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function requestLoopbackBaseUrl(req) {
  const remote = req?.socket?.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return "";
  const host = String(req?.headers?.host || "").trim();
  if (!host) return "";
  try {
    return readLoopbackBaseUrl(new URL(`http://${host}`).origin);
  } catch {
    return "";
  }
}

function createRuntimeManager(config) {
  const settings = defaultRuntimeConfig(config);
  const children = new Map();
  const logs = [];
  let phase = "stopped";
  let lastError = "";
  let startedAt = 0;

  const appendLog = (stream, chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    logs.push({ at: Date.now(), stream, text });
    if (logs.length > RUNTIME_LOG_LIMIT) logs.splice(0, logs.length - RUNTIME_LOG_LIMIT);
  };

  const snapshot = () => ({
    phase,
    startedAt,
    lastError,
    playgroundUrl: settings.playgroundUrl,
    livekitUrl: `ws://127.0.0.1:${settings.livekitPort}`,
    processes: [...children.entries()].map(([name, child]) => ({
      name,
      pid: child.pid || null,
      running: child.exitCode === null && child.signalCode === null,
    })),
    logs: logs.slice(-40),
  });

  const stopOne = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveStop) => {
      child.once("exit", resolveStop);
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill());
      } else {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolveStop();
      }, 3_000);
    });
  };

  const startOne = (name, command, args, cwd, spawnOptions = {}) => {
    if (children.has(name)) return;
    const baseOptions = {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...spawnOptions,
    };
    const spawnWith = (stdio) => {
      let child;
      try {
        child = spawn(command, args, { ...baseOptions, stdio });
      } catch (error) {
        appendLog(`${name}:spawn-error`, `${error.message}`);
        // Host runs under a sandbox that blocks piped stdio: retry without
        // capturing the child's output (logs degrade, services still start).
        if (stdio !== "ignore" && /EPERM|EACCES/i.test(String(error.code || error.message))) {
          spawnWith("ignore");
        } else {
          phase = "error";
          lastError = `${name} spawn failed: ${error.message}`;
        }
        return;
      }
      if (child.stdout) child.stdout.on("data", (chunk) => appendLog(`${name}:out`, chunk));
      if (child.stderr) child.stderr.on("data", (chunk) => appendLog(`${name}:err`, chunk));
      child.once("error", (error) => {
        children.delete(name);
        appendLog(`${name}:spawn-error`, `${error.message}`);
        if (stdio !== "ignore" && /EPERM|EACCES/i.test(String(error.code || error.message))) {
          spawnWith("ignore");
        }
      });
      child.once("exit", (code, signal) => {
        children.delete(name);
        appendLog(`${name}:exit`, `${signal || code}`);
        if (phase === "running" && code !== 0 && signal !== "SIGTERM") {
          phase = "error";
          lastError = `${name} exited with ${signal || code}`;
        }
      });
      children.set(name, child);
    };
    spawnWith(baseOptions.stdio);
  };

  const start = async (baseUrl = "") => {
    if (phase === "starting") return snapshot();
    // Idempotent "ensure each service" start: works both from a cold stop and
    // when already running. When already running it respawns only the
    // services that are actually missing (port down / tracked worker dead),
    // instead of returning a stale snapshot, which used to leave a killed
    // livekit or worker dead while phase still said "running".
    const cold = phase === "stopped" || phase === "error";
    if (cold) {
      phase = "starting";
      lastError = "";
      startedAt = Date.now();
    }
    try {
      if (!(await waitForPort(settings.livekitPort, 250))) {
        startOne("livekit", settings.livekitServer, ["--config", settings.livekitConfig], settings.projectRoot);
        await waitForPort(settings.livekitPort, 10_000);
      }
      const trackedWorker = children.get("worker");
      const workerAlive =
        trackedWorker && trackedWorker.exitCode === null && trackedWorker.signalCode === null;
      if (!workerAlive) {
        const workerEnv = { ...process.env };
        if (baseUrl) workerEnv.DSH_VOICE_URL = baseUrl;
        startOne(
          "worker",
          settings.python,
          [settings.worker, "dev"],
          settings.projectRoot,
          { env: workerEnv },
        );
      }
      if (!(await waitForPort(settings.playgroundPort, 250))) {
        startOne(
          "playground",
          process.env.ComSpec || "cmd.exe",
          ["/d", "/c", `call "${settings.npmCommand}" run dev -- --port ${settings.playgroundPort}`],
          settings.playground,
          { windowsVerbatimArguments: true },
        );
        if (!(await waitForPort(settings.playgroundPort, 20_000))) {
          throw new Error(`Playground did not open port ${settings.playgroundPort}`);
        }
      }
      phase = "running";
    } catch (error) {
      phase = "error";
      lastError = error?.message || String(error);
    }
    return snapshot();
  };

  const stop = async () => {
    phase = "stopping";
    await Promise.all([...children.values()].map(stopOne));
    children.clear();
    phase = "stopped";
    lastError = "";
    return snapshot();
  };

  const dispose = () => {
    for (const child of children.values()) {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    }
    children.clear();
  };

  return { start, stop, snapshot, dispose, settings };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseRequestUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

function readConfiguredToken(config) {
  const fromConfig = typeof config?.token === "string" ? config.token.trim() : "";
  const fromEnvironment = (process.env.DSH_VOICE_TOKEN || "").trim();
  return fromConfig || fromEnvironment;
}

function hasValidToken(req, token) {
  if (!token) return false;
  const supplied = String(
    req.headers["x-dsh-voice-token"] ||
      parseRequestUrl(req).searchParams.get("token") ||
      "",
  );
  const expectedBuffer = Buffer.from(token, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(value);
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function requireSessionId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("sessionId is required"), { statusCode: 400 });
  }
  return value.trim();
}

function requireText(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("text is required"), { statusCode: 400 });
  }
  if (value.length > 32_000) {
    throw Object.assign(new Error("text is too long"), { statusCode: 413 });
  }
  return value;
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function apply(ctx, config) {
  const token = readConfiguredToken(config);
  const runtime = createRuntimeManager(config);
  const requireAuthorized = (req, res) => {
    if (!token) {
      sendJson(res, 503, {
        error: "voice bridge disabled",
        reason: "set DSH_VOICE_TOKEN before starting the Harness",
      });
      return false;
    }
    if (!hasValidToken(req, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  };

  const requireLocal = (req, res) => {
    if (!req || !req.socket || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) {
      sendJson(res, 403, { error: "runtime control is loopback only" });
      return false;
    }
    return true;
  };

  // —— DeepSeek 余额（自 dsh-whale-widget 吞并）：让气泡的余额层不再依赖
  //    鲸鱼插件。两条取数路：API key 优先（config / 凭据服务 / 环境变量），
  //    失败退回 DSH 账号登录态（宿主可选服务 deepseekAccount，**绝不写进
  //    inject**——老宿主没有这个服务，写进 inject 会让整个插件永不 apply）。
  //    另配一个极简当日账本：今日峰值余额 − 当前余额 = 今日已用（充值会把
  //    峰值抬高的那部分视为"待核对"，不做鲸鱼插件那套人工校正，属于已知简化）。
  const BALANCE_CACHE_MS = 60_000;
  let balanceCache = { at: 0, value: null };
  const BALANCE_LEDGER_FILE = resolve(
    process.env.DSH_VOICE_BALANCE_FILE || resolve(process.env.DSH_HOME || resolve(homedir(), ".dsh"), "voice-bridge-balance.json"),
  );

  function beijingDay() {
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }

  function readBalanceLedger() {
    try {
      const value = JSON.parse(readFileSync(BALANCE_LEDGER_FILE, "utf8"));
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  function writeBalanceLedger(ledger) {
    try {
      writeFileSync(BALANCE_LEDGER_FILE, JSON.stringify(ledger, null, 2));
    } catch {
      /* ledger is best-effort */
    }
  }

  async function fetchApiKeyBalance(keyValue) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("https://api.deepseek.com/user/balance", {
          headers: { Authorization: "Bearer " + keyValue },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : [];
          const info =
            infos.find((x) => x && x.currency === "CNY" && Number(x.total_balance) > 0) ||
            infos.find((x) => Number(x.total_balance) > 0) ||
            infos.find((x) => x && x.currency === "CNY") ||
            infos[0];
          if (info && Number.isFinite(Number(info.total_balance))) {
            return {
              ok: true,
              totalBalance: Number(info.total_balance),
              rechargeBalance: Number(info.topped_up_balance) || 0,
              bonusBalance: Number(info.granted_balance) || 0,
              currency: String(info.currency || "CNY"),
              source: "apikey",
            };
          }
          return { ok: false, code: "SHAPE", error: "balance API shape unexpected" };
        }
        if (res.status < 500) return { ok: false, code: "HTTP", error: "HTTP " + res.status };
      } catch {
        /* transient: retry once */
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, code: "HTTP", error: "balance API unreachable" };
  }

  async function fetchAccountBalance() {
    let account = null;
    try {
      account = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : null;
    } catch {
      account = null;
    }
    if (!account || typeof account.getBalance !== "function") {
      return { ok: false, code: "NO_ACCOUNT_SERVICE" };
    }
    let result;
    try {
      result = await Promise.race([
        account.getBalance({
          version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || "unknown"),
          locale: String(process.env.DSH_LOCALE || "zh_CN"),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }),
        new Promise((r) => setTimeout(() => r(null), 20_000)),
      ]);
    } catch {
      return { ok: false, code: "ACCOUNT_CALL_FAILED" };
    }
    if (!result || result.status !== "ready") return { ok: false, code: "NOT_LOGGED_IN" };
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const usable = (list) => (Array.isArray(list) ? list : []).filter((w) => w && num(w.balance) !== null);
    const normWallets = usable(result.value);
    const bonusWallets = usable(result.bonusWallets);
    const all = normWallets.concat(bonusWallets);
    if (all.length === 0) return { ok: false, code: "NO_WALLETS" };
    const curOf = (w) => String((w && w.currency) || "CNY").toUpperCase();
    const nonzero = all.filter((w) => Number(w.balance) > 0);
    const pick =
      nonzero.find((w) => curOf(w) === "CNY") || nonzero[0] || all.find((w) => curOf(w) === "CNY") || all[0];
    const currency = curOf(pick);
    const sumOf = (list) =>
      list.filter((w) => curOf(w) === currency).reduce((sum, w) => sum + Number(w.balance), 0);
    const recharge = Number(sumOf(normWallets).toFixed(6));
    const bonus = Number(sumOf(bonusWallets).toFixed(6));
    return { ok: true, totalBalance: Number((recharge + bonus).toFixed(6)), rechargeBalance: recharge, bonusBalance: bonus, currency, source: "account" };
  }

  async function fetchDeepseekBalance() {
    if (balanceCache.value && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;

    let keyValue = null;
    if (typeof config.deepseekApiKey === "string" && config.deepseekApiKey.trim()) {
      keyValue = config.deepseekApiKey.trim();
    } else {
      let creds = null;
      try {
        creds = typeof ctx.get === "function" ? ctx.get("credentials") : null;
      } catch {
        creds = null;
      }
      if (creds && typeof creds.resolve === "function") {
        try {
          const entry = await creds.resolve("DEEPSEEK_API_KEY");
          keyValue = entry && entry.value;
        } catch {
          /* not configured */
        }
      }
      if (!keyValue) keyValue = process.env.DEEPSEEK_API_KEY || null;
    }

    let result = keyValue ? await fetchApiKeyBalance(keyValue) : { ok: false, code: "NO_KEY" };
    if (!result.ok) {
      const accountResult = await fetchAccountBalance();
      if (accountResult.ok) result = accountResult;
    }

    if (result.ok) {
      balanceCache = { at: Date.now(), value: result };
      const day = beijingDay();
      let ledger = readBalanceLedger();
      if (!ledger || ledger.date !== day || typeof ledger.peak !== "number") {
        ledger = { date: day, peak: null, todayUsage: 0 };
      }
      if (ledger.peak === null || result.totalBalance > ledger.peak) ledger.peak = result.totalBalance;
      ledger.todayUsage = Number(Math.max(0, ledger.peak - result.totalBalance).toFixed(6));
      ledger.updatedAt = new Date().toISOString();
      writeBalanceLedger(ledger);
      result = Object.assign({}, result, { todayUsage: ledger.todayUsage, updatedAt: ledger.updatedAt });
    }
    return result;
  }

  const runtimeStatus = ctx.webServer.register({
    kind: "exact",
    path: "/voice/runtime/status",
    handler: (req, res) => {
      if (!requireLocal(req, res)) return;
      sendJson(res, 200, runtime.snapshot());
    },
  });

  const runtimeStart = ctx.webServer.register({
    kind: "exact",
    path: "/voice/runtime/start",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!requireLocal(req, res)) return;
      const baseUrl =
        readLoopbackBaseUrl(parseRequestUrl(req).searchParams.get("baseUrl") || "") ||
        requestLoopbackBaseUrl(req);
      try {
        sendJson(res, 200, await runtime.start(baseUrl));
      } catch (error) {
        sendJson(res, 500, { error: error?.message || String(error) });
      }
    },
  });

  const runtimeStop = ctx.webServer.register({
    kind: "exact",
    path: "/voice/runtime/stop",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!requireLocal(req, res)) return;
      sendJson(res, 200, await runtime.stop());
    },
  });

  const health = ctx.webServer.register({
    kind: "exact",
    path: "/voice/health",
    handler: (_req, res) => {
      sendJson(res, 200, {
        ok: true,
        bridge: "livekit-dsh",
        version: "0.1.0",
        tokenRequired: Boolean(token),
        endpoints: [
          "/voice/sessions",
          "/voice/prompt",
          "/voice/cancel",
          "/voice/follow",
          "/voice/runtime/status",
          "/voice/runtime/start",
          "/voice/runtime/stop",
          "/voice/avatar.png",
          "/voice/balance.json",
        ],
      });
    },
  });

  const avatar = ctx.webServer.register({
    kind: "exact",
    path: "/voice/avatar.png",
    handler: (req, res) => {
      if (!requireLocal(req, res)) return;
      let stream;
      try {
        stream = createReadStream(AVATAR_FILE);
      } catch (error) {
        sendJson(res, 404, { error: "avatar not found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      stream.on("error", () => {
        try {
          res.end();
        } catch (error) {}
      });
      stream.pipe(res);
    },
  });

  const balance = ctx.webServer.register({
    kind: "exact",
    path: "/voice/balance.json",
    handler: async (_req, res) => {
      if (!requireLocal(_req, res)) return;
      try {
        sendJson(res, 200, await fetchDeepseekBalance());
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
    },
  });

  const sessions = ctx.webServer.register({
    kind: "exact",
    path: "/voice/sessions",
    handler: async (req, res) => {
      if (!requireAuthorized(req, res)) return;
      try {
        if (req.method === "GET") {
          const result = await ctx.sessionController.list(
            {},
            AbortSignal.timeout(5_000),
          );
          sendJson(res, 200, result);
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const body = await readJsonBody(req);
        const cwd = resolve(
          typeof body.cwd === "string" && body.cwd.trim()
            ? body.cwd.trim()
            : process.cwd(),
        );
        const request = { cwd };
        if (typeof body.sessionId === "string" && body.sessionId.trim()) {
          request.sessionId = body.sessionId.trim();
        }
        if (typeof body.agentPreset === "string" && body.agentPreset.trim()) {
          request.agentPreset = body.agentPreset.trim();
        }
        const result = await ctx.sessionController.create(request);
        sendJson(res, 201, result);
      } catch (error) {
        sendJson(res, Number(error?.statusCode) || 500, {
          error: error?.message || "session list failed",
        });
      }
    },
  });

  const prompt = ctx.webServer.register({
    kind: "exact",
    path: "/voice/prompt",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!requireAuthorized(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const sessionId = requireSessionId(body.sessionId);
        const text = requireText(body.text);
        const mode = body.mode === "steer" ? "steer" : "queue";
        await ctx.sessionController.resolveAgent(sessionId);
        const requestId = randomUUID();
        const result = await ctx.sessionController.prompt(
          {
            requestId,
            sessionId,
            mode,
            content: [{ type: "text", text }],
          },
          AbortSignal.timeout(15_000),
        );
        sendJson(res, 200, { ...result, requestId });
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson(res, status, { error: error?.message || "prompt failed" });
      }
    },
  });

  const cancel = ctx.webServer.register({
    kind: "exact",
    path: "/voice/cancel",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!requireAuthorized(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const sessionId = requireSessionId(body.sessionId);
        const result = await ctx.sessionController.cancel({ sessionId });
        sendJson(res, 200, result);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson(res, status, { error: error?.message || "cancel failed" });
      }
    },
  });

  const follow = ctx.webServer.register({
    kind: "exact",
    path: "/voice/follow",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!requireAuthorized(req, res)) return;

      let sessionId;
      try {
        sessionId = requireSessionId(parseRequestUrl(req).searchParams.get("sessionId"));
      } catch (error) {
        sendJson(res, Number(error?.statusCode) || 400, {
          error: error?.message || "invalid sessionId",
        });
        return;
      }

      const controller = new AbortController();
      const onClose = () => controller.abort();
      req.on("close", onClose);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);

      try {
        const frames = ctx.sessionController.follow(
          {
            address: { kind: "session", sessionId },
            assistantStream: true,
          },
          controller.signal,
        );
        for await (const frame of frames) {
          if (res.writableEnded || controller.signal.aborted) break;
          writeSse(res, frame);
          if (res.writableLength > FLOW_CONTROL_BYTES * 1024) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !res.writableEnded) {
          writeSse(res, { type: "error", message: error?.message || "follow failed" });
        }
      } finally {
        clearInterval(heartbeat);
        req.off?.("close", onClose);
        if (!res.writableEnded) res.end();
      }
    },
  });

  ctx.effect(() => () => {
    runtime.dispose();
    runtimeStatus();
    runtimeStart();
    runtimeStop();
    health();
    sessions();
    prompt();
    cancel();
    follow();
  });
}
