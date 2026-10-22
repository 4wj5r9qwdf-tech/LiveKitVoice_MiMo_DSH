window.__ModuleLoader__.load({
  id: "@local/dsh-voice-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var DEFAULT_URL = "http://127.0.0.1:3000/";
    var OPEN_EVENT = "dsh-voice-popup-open";
    var STATUS_EVENT = "dsh-voice-status";
    var FISH_POS_KEY = "dsh-voice-fish-pos";
    var BUBBLE_KEY = "dsh-voice-bubble";
    var AVATAR_SRC = "/voice/avatar.png";
    var BUBBLE_DEFAULTS = {
      showStatus: true,
      showText: true,
      showBalance: true,
      alwaysBubble: false,
      fishSize: 120,
      avatar: "",
      snap: true,
      flip: false,
      balanceAlert: 0,
      dailyBudget: 0,
      roles: [],
      soundOn: true,
      soundVol: 80,
      pressAnim: true,
      micDevice: "",
      showTurnCost: true,
      bubbleHideSec: 5,
    };

    // 设置卡「语音服务」区块可编辑的 .env 白名单键（宿主 /voice/config 提供）
    var CFG_MODEL_KEYS = [
      "MIMO_API_KEY",
      "MIMO_BASE_URL",
      "LLM_PROVIDER",
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LLM_MODEL",
    ];
    var CFG_PARAM_KEYS = [
      "VOICE_VAD_MIN_SILENCE",
      "VOICE_ENDPOINT_MIN_DELAY",
      "VOICE_ENDPOINT_MAX_DELAY",
      "VOICE_INTERRUPT_MIN",
      "VOICE_TTS_CHUNK_LIMIT",
    ];

    function loadJSON(key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        var v = JSON.parse(raw);
        return v && typeof v === "object" ? v : fallback;
      } catch (error) {
        return fallback;
      }
    }

    function saveJSON(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* storage unavailable */
      }
    }

    function defaultFishPos(size) {
      var s = Number(size) || 120;
      return {
        x: Math.max(8, Math.round(window.innerWidth - s - 28)),
        y: Math.max(8, Math.round(window.innerHeight - s - 28)),
      };
    }

    function playgroundUrl(sessionId) {
      var query = new URLSearchParams({ dshSessionId: sessionId || "" });
      return `${DEFAULT_URL}?${query.toString()}`;
    }

    function request(path, options) {
      return fetch(path, options).then(async (response) => {
        var value = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
        return value;
      });
    }

    function fmtMoney(value) {
      var n = Number(value);
      if (!isFinite(n)) return "--";
      return n.toFixed(2);
    }

    // 点击音效：宿主 /voice/sound.mp3?id=ya1|ya2（按下/松开），预缓存 Audio 实例
    var soundCache = {};
    function playSound(id, volPercent) {
      try {
        var v = Math.max(0, Math.min(1, Number(volPercent) / 100 || 0.8));
        var key = id + "_" + Math.round(v * 20);
        if (!soundCache[key]) soundCache[key] = new Audio("/voice/sound.mp3?id=" + id);
        var a = soundCache[key];
        a.volume = v;
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
      } catch (error) {
        /* audio unavailable */
      }
    }

    var STATUS_LABELS = {
      idle: "空闲",
      listening: "聆听中",
      thinking: "思考中",
      speaking: "播报中",
    };
    var STATUS_COLORS = {
      idle: "#64748b",
      listening: "#22c55e",
      thinking: "#f59e0b",
      speaking: "#3b82f6",
    };

    function VoiceAction({ sessionId, onOpen }) {
      var stateHook = React.useState({
        phase: "unknown",
        playgroundUrl: DEFAULT_URL,
        lastError: "",
      });
      var state = stateHook[0];
      var setState = stateHook[1];
      var busyHook = React.useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];

      var refresh = React.useCallback(function () {
        return request("/voice/runtime/status")
          .then(function (value) {
            setState(value);
          })
          .catch(function (error) {
            setState(function (previous) {
              return Object.assign({}, previous, {
                phase: "error",
                lastError: error.message,
              });
            });
          });
      }, []);

      React.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 2000);
        return function () {
          clearInterval(timer);
        };
      }, [refresh]);

      var run = React.useCallback(
        function (path) {
          setBusy(true);
          request(path, { method: "POST" })
            .then(function (value) {
              setState(value);
              if (value.phase === "running") onOpen();
            })
            .catch(function (error) {
              setState(function (previous) {
                return Object.assign({}, previous, {
                  phase: "error",
                  lastError: error.message,
                });
              });
            })
            .finally(function () {
              setBusy(false);
            });
        },
        [onOpen],
      );

      var running = state.phase === "running" || state.phase === "starting";
      var buttonStyle = {
        background: running ? "#3a1f2d" : "transparent",
        border: "1px solid " + (running ? "#7f1d1d" : "#334155"),
        borderRadius: "6px",
        color: running ? "#fecaca" : "#e2e8f0",
        cursor: busy ? "wait" : "pointer",
        fontSize: "12px",
        padding: "5px 9px",
      };

      return React.createElement(
        "button",
        {
          "aria-label": running ? "停止语音服务" : "打开语音对话",
          disabled: busy,
          onClick: function () {
            run(
              running
                ? "/voice/runtime/stop"
                : "/voice/runtime/start",
            );
          },
          style: buttonStyle,
          title: state.lastError || (running ? "停止语音服务" : "启动并打开语音对话"),
          type: "button",
        },
        busy ? "处理中..." : running ? "停止语音" : "语音",
      );
    }

    function VoicePopup() {
      var uiHook = React.useState({ open: false, sessionId: "" });
      var ui = uiHook[0];
      var setUi = uiHook[1];

      var settingsHook = React.useState(function () {
        var saved = loadJSON(BUBBLE_KEY, {});
        var isLegacy = !saved || saved.alwaysBubble === undefined; // 旧版（小圆头像）存的配置
        var s = Object.assign({}, BUBBLE_DEFAULTS, saved || {});
        s.fishSize = Math.max(64, Math.min(200, Number(s.fishSize) || 120));
        // One-time migration: legacy 72px settings get the new larger default.
        if (isLegacy) s.fishSize = 120;
        return s;
      });
      var settings = settingsHook[0];
      var setSettings = settingsHook[1];

      var fishPosHook = React.useState(function () {
        var saved = loadJSON(FISH_POS_KEY, null);
        return saved && typeof saved.x === "number" ? saved : null;
      });
      var fishPos = fishPosHook[0];
      var setFishPos = fishPosHook[1];

      var liveHook = React.useState({ status: "", text: "" });
      var live = liveHook[0];
      var setLive = liveHook[1];

      var balanceHook = React.useState(null);
      var balance = balanceHook[0];
      var setBalance = balanceHook[1];

      var cardOpenHook = React.useState(false);
      var cardOpen = cardOpenHook[0];
      var setCardOpen = cardOpenHook[1];

      var cardBusyHook = React.useState(false);
      var cardBusy = cardBusyHook[0];
      var setCardBusy = cardBusyHook[1];

      // 语音服务配置（.env 白名单键）：卡片打开时从 /voice/config 载入
      var cfgHook = React.useState({});
      var cfg = cfgHook[0];
      var setCfg = cfgHook[1];
      var cfgMsgHook = React.useState("");
      var cfgMsg = cfgMsgHook[0];
      var setCfgMsg = cfgMsgHook[1];

      // 每轮消耗（复用 dsh-whale-widget 已实现的记账：/dsh-whale/last-turn.json，
      // 只统计 DSH 会话里实际发生的那一轮大脑模型用量，不含 MiMo 耳/嘴）
      var turnHook = React.useState(null);
      var turn = turnHook[0];
      var setTurn = turnHook[1];

      var lastTurnSeen = React.useRef(0);

      var characterRef = React.useRef(null);
      var iframeRef = React.useRef(null);

      // 按压回弹 + 音效
      var pressingHook = React.useState(false);
      var pressing = pressingHook[0];
      var setPressing = pressingHook[1];

      // 麦克风设备列表（来自 iframe 内的 enumerateDevices）
      var devicesHook = React.useState([]);
      var devices = devicesHook[0];
      var setDevices = devicesHook[1];

      // 手动「隐藏本次」气泡：收起后在新一轮消耗结算（seq 递增）或新一轮对话开始
      // （状态 idle→活动）之前保持隐藏，二者任一发生即恢复显示
      var dismissedHook = React.useState(false);
      var dismissed = dismissedHook[0];
      var setDismissed = dismissedHook[1];
      var liveStatusRef = React.useRef("");

      var sendIframeCmd = function (cmd) {
        var el = iframeRef.current;
        if (el && el.contentWindow && el.contentWindow.postMessage) {
          el.contentWindow.postMessage(Object.assign({ type: "dsh-voice-command" }, cmd), "*");
        }
      };

      var avatarSrc =
        settings.avatar && String(settings.avatar).trim()
          ? String(settings.avatar).trim()
          : AVATAR_SRC;
      var size = settings.fishSize;

      // 轮询鲸鱼插件的每轮消耗；seq 递增 = 新轮结算完成
      React.useEffect(function () {
        if (!ui.open) return;
        var stopped = false;
        var tick = function () {
          try {
            fetch("/dsh-whale/last-turn.json")
              .then(function (response) {
                return response.ok ? response.json() : null;
              })
              .then(function (json) {
                if (stopped || !json || !json.ok) return;
                if (Number(json.seq) > lastTurnSeen.current) {
                  lastTurnSeen.current = Number(json.seq);
                  setTurn({
                    amount: json.amount,
                    tokens: json.tokens,
                    at: Date.now(),
                  });
                  // 新一轮消耗结算 ⇒ 解除「隐藏本次」（手动收起只影响上一轮）
                  setDismissed(false);
                }
              })
              .catch(function () {});
          } catch (error) {
            /* whale widget absent */
          }
        };
        tick();
        var timer = setInterval(tick, 5000);
        return function () {
          stopped = true;
          clearInterval(timer);
        };
      }, [ui.open]);

      // 打开卡片时载入 .env 配置
      React.useEffect(function () {
        if (!cardOpen || !ui.open) return;
        var cancelled = false;
        request("/voice/config")
          .then(function (value) {
            if (!cancelled && value && value.values) setCfg(value.values);
          })
          .catch(function () {});
        return function () {
          cancelled = true;
        };
      }, [cardOpen, ui.open]);

      var applyConfig = function () {
        setCardBusy(true);
        setCfgMsg("保存中...");
        var payload = {};
        (CFG_MODEL_KEYS.concat(CFG_PARAM_KEYS)).forEach(function (key) {
          if (cfg[key] !== undefined && cfg[key] !== null) payload[key] = String(cfg[key]);
        });
        request("/voice/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: payload }),
        })
          .then(function () {
            return request("/voice/runtime/restart-worker", { method: "POST" });
          })
          .then(function () {
            setCfgMsg("已保存，语音服务已重启生效");
          })
          .catch(function (error) {
            setCfgMsg("保存失败：" + (error.message || "未知错误"));
          })
          .finally(function () {
            setCardBusy(false);
          });
      };

      var addRole = function (file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = String(reader.result || "");
          setSettings(function (previous) {
            var next = Object.assign({}, previous);
            next.roles = (next.roles || []).concat([
              { name: String(file.name || "角色").replace(/\.[a-z0-9]+$/i, ""), dataUrl: dataUrl },
            ]);
            next.avatar = dataUrl;
            saveJSON(BUBBLE_KEY, next);
            return next;
          });
        };
        reader.readAsDataURL(file);
      };

      var removeRole = function (index) {
        setSettings(function (previous) {
          var next = Object.assign({}, previous);
          next.roles = (next.roles || []).filter(function (_r, i) {
            return i !== index;
          });
          // 若删掉的是当前头像，回退默认
          var gone = (previous.roles || [])[index];
          if (gone && previous.avatar === gone.dataUrl) next.avatar = "";
          saveJSON(BUBBLE_KEY, next);
          return next;
        });
      };

      var updateSettings = React.useCallback(function (patch) {
        setSettings(function (previous) {
          var next = Object.assign({}, previous, patch);
          next.fishSize = Math.max(64, Math.min(200, Number(next.fishSize) || 120));
          saveJSON(BUBBLE_KEY, next);
          return next;
        });
      }, []);

      // —— 角色立绘拖动：moved 才移动位置；单击（未拖动）= 开/关设置卡片 ——
      var startCharacterDrag = function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        var target = characterRef.current;
        if (!target) return;
        if (settings.soundOn) playSound("ya1", settings.soundVol);
        setPressing(true);
        var startPos = fishPos || defaultFishPos(size);
        var startX = event.clientX;
        var startY = event.clientY;
        var moved = false;
        target.style.left = startPos.x + "px";
        target.style.top = startPos.y + "px";

        var onMove = function (ev) {
          var dx = ev.clientX - startX;
          var dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
          if (!moved) return;
          var next = {
            x: Math.max(0, Math.min(startPos.x + dx, window.innerWidth - size)),
            y: Math.max(0, Math.min(startPos.y + dy, window.innerHeight - size)),
          };
          target.style.left = next.x + "px";
          target.style.top = next.y + "px";
        };
        var onUp = function () {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          setPressing(false);
          if (settings.soundOn) playSound("ya2", settings.soundVol);
          if (moved) {
            var rect = characterRef.current ? characterRef.current.getBoundingClientRect() : null;
            var next = rect
              ? { x: Math.round(rect.left), y: Math.round(rect.top) }
              : { x: startPos.x, y: startPos.y };
            if (settings.snap) {
              // 吸附：贴最近的左右 / 上下边（24px 边距）
              var m = 24;
              var xs = [m, window.innerWidth - size - m];
              next.x = Math.abs(next.x - xs[0]) <= Math.abs(next.x - xs[1]) ? xs[0] : xs[1];
              var ys = [m, window.innerHeight - size - m];
              next.y = Math.abs(next.y - ys[0]) <= Math.abs(next.y - ys[1]) ? ys[0] : ys[1];
              target.style.left = next.x + "px";
              target.style.top = next.y + "px";
            }
            setFishPos(next);
            saveJSON(FISH_POS_KEY, next);
          } else {
            setCardOpen(function (open) {
              return !open;
            });
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      var resetFishPos = function () {
        setFishPos(null);
        saveJSON(FISH_POS_KEY, null);
      };

      var stopRuntime = function () {
        setCardBusy(true);
        request("/voice/runtime/stop", { method: "POST" })
          .then(function () {})
          .catch(function () {})
          .finally(function () {
            setCardBusy(false);
          });
      };

      var closePopup = function () {
        setUi({ open: false, sessionId: "" });
        setCardOpen(false);
      };

      React.useEffect(function () {
        var onOpen = function (event) {
          setUi({
            open: true,
            sessionId: event.detail && event.detail.sessionId ? String(event.detail.sessionId) : "",
          });
        };
        window.addEventListener(OPEN_EVENT, onOpen);
        return function () {
          window.removeEventListener(OPEN_EVENT, onOpen);
        };
      }, []);

      // 状态 + 字幕 + 麦克风设备列表：来自嵌入 Playground iframe 的 postMessage 上报。
      React.useEffect(function () {
        var onMsg = function (event) {
          var data = event && event.data;
          if (data && data.type === STATUS_EVENT) {
            var newStatus = String(data.status || "");
            var prevStatus = liveStatusRef.current;
            if (
              (prevStatus === "" || prevStatus === "idle") &&
              newStatus &&
              newStatus !== "idle"
            ) {
              // 新一轮对话开始（聆听/思考/播报）⇒ 解除「隐藏本次」
              setDismissed(false);
            }
            liveStatusRef.current = newStatus;
            setLive({
              status: newStatus,
              text: String(data.text || ""),
              mic: Boolean(data.mic),
            });
          }
          if (data && data.type === "dsh-voice-devices" && Array.isArray(data.devices)) {
            setDevices(data.devices);
          }
        };
        window.addEventListener("message", onMsg);
        return function () {
          window.removeEventListener("message", onMsg);
        };
      }, []);

      // 余额：由本插件宿主路由 /voice/balance.json 提供（API key 优先，
      // 退回 DSH 账号登录态，附当日账本）。拿不到就隐藏这一层。
      React.useEffect(function () {
        if (!ui.open) return;
        var stopped = false;
        var tick = function () {
          try {
            fetch("/voice/balance.json", { signal: AbortSignal.timeout(25000) })
              .then(function (response) {
                return response.ok ? response.json() : null;
              })
              .then(function (json) {
                if (!stopped && json && json.ok) setBalance(json);
              })
              .catch(function () {});
          } catch (error) {
            /* fetch unavailable */
          }
        };
        tick();
        var timer = setInterval(tick, 30000);
        return function () {
          stopped = true;
          clearInterval(timer);
        };
      }, [ui.open]);

      if (!ui.open) return null;

      var fish = fishPos || defaultFishPos(size);
      var statusKey = STATUS_COLORS[live.status] ? live.status : "idle";

      // —— 角色立绘（大肥鱼）——
      var character = React.createElement(
        "div",
        {
          key: "character",
          ref: characterRef,
          onMouseDown: startCharacterDrag,
          onContextMenu: function (event) {
            event.preventDefault();
            event.stopPropagation();
            setCardOpen(true);
          },
          title: "拖动移动 · 单击/右键 打开设置",
          style: {
            position: "absolute",
            left: fish.x + "px",
            top: fish.y + "px",
            width: size + "px",
            height: size + "px",
            pointerEvents: "auto",
            cursor: "grab",
            userSelect: "none",
            zIndex: 4,
          },
        },
        React.createElement("img", {
          src: avatarSrc,
          alt: "语音伴随",
          draggable: false,
          style: {
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            pointerEvents: "none",
            userSelect: "none",
            transformOrigin: "50% 100%",
            transition: settings.pressAnim
              ? "transform 180ms cubic-bezier(.34,1.56,.64,1)"
              : "none",
            transform:
              (settings.flip ? "scaleX(-1) " : "") +
              (pressing && settings.pressAnim ? "scale(0.94)" : ""),
          },
        }),
        React.createElement("span", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            top: "4%",
            right: "4%",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: STATUS_COLORS[statusKey],
            border: "2px solid #fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.4)",
          },
        }),
        React.createElement(
          "button",
          {
            id: "dsh-voice-gear",
            type: "button",
            "aria-label": "伴随设置",
            title: "伴随设置",
            onMouseDown: function (event) {
              event.stopPropagation();
            },
            onClick: function (event) {
              event.stopPropagation();
              setCardOpen(true);
            },
            style: {
              position: "absolute",
              right: "2%",
              bottom: "2%",
              width: "26px",
              height: "26px",
              borderRadius: "50%",
              border: "1px solid #475569",
              background: "rgba(15,23,42,.85)",
              color: "#e2e8f0",
              fontSize: "13px",
              lineHeight: "24px",
              textAlign: "center",
              cursor: "pointer",
              padding: "0",
              pointerEvents: "auto",
            },
          },
          "⚙",
        ),
      );

      // —— 气泡（可勾选的内容层；对话中显示，结束后停留 bubbleHideSec 秒自动收起）——
      var statusActive = live.status && live.status !== "idle";
      // 对话结束后气泡停留时长（秒；0 = 不自动隐藏）——语义沿用鲸鱼插件
      // 「每轮消耗泡泡」的自动关闭（其出厂默认 5s，对应 turnCostCloseMs=5000）
      var hideSec = Math.max(0, Math.round(Number(settings.bubbleHideSec) || 0));
      var turnFresh = Boolean(
        turn &&
          turn.amount != null &&
          (hideSec === 0 ? true : Date.now() - turn.at < hideSec * 1000),
      );
      var warnLow =
        balance &&
        Number(settings.balanceAlert) > 0 &&
        Number(balance.totalBalance) < Number(settings.balanceAlert);
      var warnBudget =
        balance &&
        Number(settings.dailyBudget) > 0 &&
        Number(balance.todayUsage) >= Number(settings.dailyBudget);
      // dismissed = 用户点了气泡右上角 ×（隐藏本次）：轮到新一轮消耗结算或
      // 新一轮对话开始（idle→活动）才恢复
      var bubbleVisible =
        !dismissed && (settings.alwaysBubble || statusActive || turnFresh || warnLow || warnBudget);

      var bubbleLines = [];
      if (bubbleVisible) {
        if (settings.showStatus && (statusActive || settings.alwaysBubble)) {
          bubbleLines.push(
            (STATUS_LABELS[live.status] || "空闲") + (live.status === "speaking" ? "…" : ""),
          );
        }
        if (settings.showText && live.text && (statusActive || turnFresh)) {
          bubbleLines.push(live.text.length > 80 ? "…" + live.text.slice(-77) : live.text);
        }
        if (settings.showBalance && balance) {
          bubbleLines.push(
            "余额 ¥" +
              fmtMoney(balance.totalBalance) +
              " · 今日 ¥" +
              fmtMoney(balance.todayUsage),
          );
        }
        // 每轮消耗：抄自 dsh-whale-widget 的「每轮消耗泡泡」——轮询 last-turn.json，
        // seq 递增（一轮结算完成）时显示「上一轮对话消耗 + ¥ 金额」默认模板
        // （其第 3 行「今日已用」由上面的余额行覆盖，不重复；token 数取自记账的
        // tokens 字段，鲸鱼泡泡未展示、按需求补上）
        if (turnFresh && settings.showTurnCost && turn) {
          var amtNum = Number(turn.amount) || 0;
          var amtText =
            amtNum < 0.01 ? amtNum.toFixed(4) : amtNum < 1 ? amtNum.toFixed(3) : amtNum.toFixed(2);
          var tokNote =
            turn.tokens && Number(turn.tokens) > 0
              ? " · " + Number(turn.tokens).toLocaleString() + " tok"
              : "";
          bubbleLines.push("上一轮对话消耗");
          bubbleLines.push("¥ " + amtText + tokNote);
        }
        // 提醒层：余额预警 / 今日预算（独立于 showBalance 开关，触发时气泡强制展开）
        if (warnLow) {
          bubbleLines.push(
            "⚠ 余额 ¥" + fmtMoney(balance.totalBalance) + " 低于预警线 ¥" + fmtMoney(settings.balanceAlert),
          );
        }
        if (warnBudget) {
          bubbleLines.push(
            "⚠ 今日已用 ¥" + fmtMoney(balance.todayUsage) + "，已达预算 ¥" + fmtMoney(settings.dailyBudget),
          );
        }
        if (bubbleLines.length === 0) bubbleLines.push("空闲");
      }

      var BUBBLE_W = 230;
      var bubbleLeft = fish.x + size / 2 - BUBBLE_W / 2;
      bubbleLeft = Math.max(8, Math.min(bubbleLeft, window.innerWidth - BUBBLE_W - 8));
      // 气泡底边锚在角色头顶上方 10px：无论几行都不会被角色遮挡；
      // 角色太靠上时翻到角色下方。
      var bubbleAbove = fish.y > 140;

      var bubble =
        bubbleLines.length > 0
          ? React.createElement(
              "div",
              {
                key: "bubble",
                role: "presentation",
                style: {
                  position: "absolute",
                  left: bubbleLeft + "px",
                  top: bubbleAbove ? "auto" : fish.y + size + 10 + "px",
                  bottom: bubbleAbove ? window.innerHeight - fish.y + 10 + "px" : "auto",
                  width: BUBBLE_W + "px",
                  maxWidth: "calc(100vw - 24px)",
                  background: "#fff",
                  color: "#203170",
                  border: "1px solid rgba(32,49,112,.35)",
                  borderRadius: "10px",
                  boxShadow: "0 6px 18px rgba(15,25,60,.25)",
                  padding: "8px 10px",
                  fontSize: "12px",
                  lineHeight: 1.55,
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  zIndex: 5,
                },
              },
              bubbleLines.join("\n"),
              // 手动「隐藏本次」：本轮触发期间保持收起，新一轮消耗结算 /
              // 新一轮对话开始时自动恢复
              React.createElement(
                "span",
                {
                  key: "bubble-close",
                  "aria-label": "隐藏本次气泡",
                  title: "隐藏本次气泡（下一轮对话再显示）",
                  onClick: function () {
                    setDismissed(true);
                  },
                  style: {
                    position: "absolute",
                    top: "2px",
                    right: "6px",
                    fontSize: "13px",
                    lineHeight: "14px",
                    color: "#94a3b8",
                    cursor: "pointer",
                    pointerEvents: "auto",
                    userSelect: "none",
                  },
                },
                "×",
              ),
            )
          : null;

      // —— 设置卡片（锚定角色，不再固定在屏幕右上角）——
      var CARD_W = 300;
      var CARD_H = 430;
      var cardLeft = fish.x + size + 14;
      if (cardLeft + CARD_W > window.innerWidth - 8) {
        cardLeft = Math.max(8, fish.x - CARD_W - 14);
      }
      var cardTop = Math.max(8, Math.min(fish.y - 30, window.innerHeight - CARD_H - 8));

      var checkbox = function (key, label) {
        return React.createElement(
          "label",
          {
            key: key,
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              margin: "6px 0",
              cursor: "pointer",
              fontSize: "12px",
            },
          },
          React.createElement("input", {
            type: "checkbox",
            checked: Boolean(settings[key]),
            onChange: function (event) {
              updateSettings({ [key]: event.target.checked });
            },
          }),
          label,
        );
      };

      var fileInput = React.createElement(
        "input",
        {
          key: "file",
          type: "file",
          accept: "image/*",
          style: { display: "none" },
          id: "dsh-voice-avatar-file",
          onChange: function (event) {
            var file = event.target.files && event.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
              updateSettings({ avatar: String(reader.result || "") });
            };
            reader.readAsDataURL(file);
            event.target.value = "";
          },
        },
      );

      var smallButton = function (label, onClick, disabled) {
        return React.createElement(
          "button",
          {
            type: "button",
            disabled: disabled,
            onClick: onClick,
            style: {
              appearance: "none",
              border: "1px solid #475569",
              borderRadius: "6px",
              background: "rgba(30,41,59,.8)",
              color: "#e2e8f0",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.55 : 1,
              fontSize: "12px",
              padding: "5px 9px",
            },
          },
          label,
        );
      };

      // .env 配置输入行（语音模型 / 语音参数区块）
      var inputRow = function (label, key, type) {
        return React.createElement(
          "div",
          {
            key: key,
            style: { display: "flex", alignItems: "center", gap: "6px", margin: "4px 0" },
          },
          React.createElement(
            "span",
            {
              style: {
                flex: "0 0 84px",
                fontSize: "11px",
                color: "#94a3b8",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            },
            label,
          ),
          React.createElement("input", {
            type: type || "text",
            value: cfg[key] != null ? String(cfg[key]) : "",
            onChange: function (event) {
              setCfg(function (previous) {
                var next = Object.assign({}, previous);
                next[key] = event.target.value;
                return next;
              });
            },
            spellCheck: false,
            style: {
              flex: "1",
              minWidth: "0",
              border: "1px solid #475569",
              borderRadius: "5px",
              background: "rgba(30,41,59,.8)",
              color: "#e2e8f0",
              fontSize: "11px",
              padding: "4px 6px",
              fontFamily: "inherit",
            },
          }),
        );
      };

      // 本地设置数字行（提醒阈值，存 localStorage，即时生效）
      var settingRow = function (label, key, type) {
        return React.createElement(
          "div",
          {
            key: key,
            style: { display: "flex", alignItems: "center", gap: "6px", margin: "4px 0" },
          },
          React.createElement(
            "span",
            {
              style: {
                flex: "0 0 84px",
                fontSize: "11px",
                color: "#94a3b8",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            },
            label,
          ),
          React.createElement("input", {
            type: type || "text",
            value: settings[key] != null ? String(settings[key]) : "",
            onChange: function (event) {
              var raw = event.target.value;
              var value = type === "number" ? Number(raw) || 0 : raw;
              updateSettings({ [key]: value });
            },
            style: {
              flex: "1",
              minWidth: "0",
              border: "1px solid #475569",
              borderRadius: "5px",
              background: "rgba(30,41,59,.8)",
              color: "#e2e8f0",
              fontSize: "11px",
              padding: "4px 6px",
              fontFamily: "inherit",
            },
          }),
        );
      };

      // 音效音量滑杆取值（0-100；localStorage 里非法值回落默认 80）
      var volValue = isFinite(Number(settings.soundVol))
        ? Math.max(0, Math.min(100, Number(settings.soundVol)))
        : 80;

      var card = cardOpen
        ? React.createElement(
            "div",
            {
              key: "card",
              role: "dialog",
              "aria-label": "伴随设置",
              style: {
                position: "absolute",
                left: cardLeft + "px",
                top: cardTop + "px",
                width: CARD_W + "px",
                maxWidth: "calc(100vw - 24px)",
                maxHeight: "calc(100vh - 24px)",
                overflowY: "auto",
                background: "rgba(15,23,42,.97)",
                border: "1px solid #334155",
                borderRadius: "10px",
                padding: "12px",
                zIndex: 6,
                pointerEvents: "auto",
                color: "#e2e8f0",
                boxShadow: "0 18px 48px rgba(0,0,0,.45)",
              },
            },
            React.createElement(
              "div",
              {
                key: "title",
                style: {
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "13px",
                  fontWeight: "600",
                },
              },
              "语音伴随设置",
              React.createElement(
                "button",
                {
                  type: "button",
                  "aria-label": "关闭设置",
                  onClick: function () {
                    setCardOpen(false);
                  },
                  style: {
                    appearance: "none",
                    border: "0",
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: "16px",
                    padding: "2px 6px",
                  },
                },
                "x",
              ),
            ),
            React.createElement("div", { key: "grp1", style: { fontSize: "11px", color: "#94a3b8", marginTop: "8px" } }, "气泡内容"),
            checkbox("showStatus", "显示语音状态（空闲/聆听/思考/播报）"),
            checkbox("showText", "显示 Agent 实时字幕"),
            checkbox("showBalance", "显示 DeepSeek 余额 / 今日已用"),
            checkbox("showTurnCost", "显示每轮消耗（复用大肥鱼记账）"),
            checkbox("alwaysBubble", "气泡常显（没有内容时也显示）"),
            settingRow("对话结束后隐藏（秒，0=不自动隐藏）", "bubbleHideSec", "number"),
            React.createElement("div", { key: "grp2", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "角色大小"),
            React.createElement(
              "div",
              {
                key: "size",
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                },
              },
              "64",
              React.createElement("input", {
                type: "range",
                min: "64",
                max: "200",
                step: "8",
                value: String(size),
                style: { flex: "1" },
                onChange: function (event) {
                  updateSettings({ fishSize: Number(event.target.value) });
                },
              }),
              "200",
              String(size) + "px",
            ),
            React.createElement("div", { key: "grp3", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "角色"),
            React.createElement(
              "div",
              {
                key: "avatar",
                style: { display: "flex", alignItems: "center", gap: "8px", margin: "6px 0" },
              },
              React.createElement("img", {
                src: avatarSrc,
                alt: "当前头像",
                style: {
                  width: "40px",
                  height: "40px",
                  objectFit: "contain",
                  background: "rgba(30,41,59,.6)",
                  borderRadius: "6px",
                  flex: "0 0 auto",
                },
              }),
              smallButton(
                "导入图片",
                function () {
                  var el = document.getElementById("dsh-voice-avatar-file");
                  if (el && el.click) el.click();
                },
                cardBusy,
              ),
              settings.avatar
                ? smallButton(
                    "恢复默认",
                    function () {
                      updateSettings({ avatar: "" });
                    },
                    cardBusy,
                  )
                : null,
              fileInput,
            ),
            React.createElement(
              "div",
              {
                key: "roles",
                style: { display: "flex", alignItems: "center", gap: "6px", margin: "6px 0", flexWrap: "wrap" },
              },
              (settings.roles || []).map(function (role, i) {
                var selected = settings.avatar === role.dataUrl;
                return React.createElement(
                  "div",
                  { key: i, style: { position: "relative" } },
                  React.createElement("img", {
                    src: role.dataUrl,
                    alt: role.name,
                    title: (role.name || "角色") + "（点击选用）",
                    onClick: function () {
                      updateSettings({ avatar: role.dataUrl });
                    },
                    style: {
                      width: "36px",
                      height: "36px",
                      objectFit: "contain",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: "rgba(30,41,59,.6)",
                      border: selected ? "1px solid #3b82f6" : "1px solid rgba(30,41,59,.6)",
                    },
                  }),
                  React.createElement(
                    "span",
                    {
                      "aria-label": "删除角色",
                      onClick: function () {
                        removeRole(i);
                      },
                      style: {
                        position: "absolute",
                        top: "-4px",
                        right: "-4px",
                        width: "14px",
                        height: "14px",
                        borderRadius: "50%",
                        background: "#1e293b",
                        border: "1px solid #475569",
                        color: "#f87171",
                        fontSize: "9px",
                        lineHeight: "12px",
                        textAlign: "center",
                        cursor: "pointer",
                      },
                    },
                    "×",
                  ),
                );
              }),
              smallButton(
                "添加角色",
                function () {
                  var el = document.getElementById("dsh-voice-role-file");
                  if (el && el.click) el.click();
                },
                cardBusy,
              ),
              React.createElement("input", {
                key: "rolefile",
                type: "file",
                accept: "image/*",
                multiple: true,
                style: { display: "none" },
                id: "dsh-voice-role-file",
                onChange: function (event) {
                  var files = event.target.files ? Array.prototype.slice.call(event.target.files) : [];
                  files.forEach(addRole);
                  event.target.value = "";
                },
              }),
            ),
            checkbox("snap", "拖拽后吸附到最近边缘"),
            checkbox("flip", "角色水平翻转（面向左侧）"),
            React.createElement("div", { key: "grpSnd", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "音效"),
            checkbox("soundOn", "点击音效"),
            checkbox("pressAnim", "按压回弹动画"),
            React.createElement(
              "div",
              {
                key: "vol",
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  margin: "4px 0",
                  fontSize: "12px",
                },
              },
              "音量",
              React.createElement("input", {
                type: "range",
                min: "0",
                max: "100",
                step: "5",
                value: String(volValue),
                style: { flex: "1" },
                onChange: function (event) {
                  updateSettings({ soundVol: Number(event.target.value) });
                },
              }),
              volValue + "%",
            ),
            React.createElement("div", { key: "grpMic", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "麦克风"),
            React.createElement(
              "div",
              { key: "micSel", style: { display: "flex", gap: "6px", margin: "6px 0" } },
              React.createElement(
                "select",
                {
                  value: settings.micDevice ? String(settings.micDevice) : "",
                  onChange: function (event) {
                    var id = String(event.target.value || "");
                    updateSettings({ micDevice: id });
                    sendIframeCmd({ cmd: "set-mic", deviceId: id });
                  },
                  style: {
                    flex: "1",
                    minWidth: "0",
                    border: "1px solid #475569",
                    borderRadius: "5px",
                    background: "rgba(30,41,59,.8)",
                    color: "#e2e8f0",
                    fontSize: "11px",
                    padding: "4px 6px",
                    fontFamily: "inherit",
                  },
                },
                React.createElement("option", { value: "" }, "系统默认"),
                (devices || []).map(function (device, i) {
                  return React.createElement(
                    "option",
                    {
                      key: device.id || i,
                      value: device.id ? String(device.id) : "",
                    },
                    device.label || "麦克风 " + (i + 1),
                  );
                }),
              ),
            ),
            React.createElement(
              "div",
              {
                key: "micTog",
                style: {
                  display: "flex",
                  gap: "6px",
                  alignItems: "center",
                  margin: "4px 0",
                },
              },
              smallButton(
                "开麦",
                function () {
                  sendIframeCmd({ cmd: "mic-on" });
                },
                cardBusy,
              ),
              smallButton(
                "关麦",
                function () {
                  sendIframeCmd({ cmd: "mic-off" });
                },
                cardBusy,
              ),
              React.createElement(
                "span",
                {
                  style: {
                    fontSize: "11px",
                    color: live.mic ? "#4ade80" : "#64748b",
                  },
                },
                live.mic ? "麦克风开" : "麦克风关",
              ),
            ),
            React.createElement("div", { key: "grp4", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "连接"),
            React.createElement(
              "div",
              {
                key: "conn",
                style: { display: "flex", gap: "8px", margin: "6px 0" },
              },
              smallButton(cardBusy ? "处理中..." : "断开连接", stopRuntime, cardBusy),
              smallButton("关闭小鱼", closePopup, cardBusy),
            ),
            React.createElement("div", { key: "grp6", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "提醒（气泡警示行）"),
            settingRow("余额预警（元，0=关）", "balanceAlert", "number"),
            settingRow("今日预算（元，0=关）", "dailyBudget", "number"),
            React.createElement("div", { key: "grp7", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "语音模型（.env）"),
            inputRow("MiMo Key（耳/嘴）", "MIMO_API_KEY"),
            inputRow("MiMo 地址", "MIMO_BASE_URL"),
            inputRow("大脑模式", "LLM_PROVIDER"),
            inputRow("回退 Key", "LLM_API_KEY"),
            inputRow("回退地址", "LLM_BASE_URL"),
            inputRow("回退模型", "LLM_MODEL"),
            React.createElement("div", { key: "grp8", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "语音参数（.env）"),
            inputRow("静音判定（秒）", "VOICE_VAD_MIN_SILENCE", "number"),
            inputRow("等待窗起（秒）", "VOICE_ENDPOINT_MIN_DELAY", "number"),
            inputRow("等待窗止（秒）", "VOICE_ENDPOINT_MAX_DELAY", "number"),
            inputRow("打断阈值（秒）", "VOICE_INTERRUPT_MIN", "number"),
            inputRow("TTS 分句字数", "VOICE_TTS_CHUNK_LIMIT", "number"),
            React.createElement("div", { key: "grp9", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "应用"),
            React.createElement(
              "div",
              {
                key: "apply",
                style: { display: "flex", alignItems: "center", gap: "8px", margin: "6px 0", flexWrap: "wrap" },
              },
              smallButton(cardBusy ? "处理中..." : "保存并重启语音服务", applyConfig, cardBusy),
              React.createElement(
                "span",
                {
                  style: { fontSize: "11px", color: cfgMsg ? "#4ade80" : "#64748b", lineHeight: 1.4 },
                },
                cfgMsg || "改「语音模型 / 语音参数」后需保存并重启；其余项即时生效。",
              ),
            ),
            React.createElement("div", { key: "grp5", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "位置"),
            React.createElement(
              "div",
              {
                key: "pos",
                style: { display: "flex", gap: "8px", margin: "6px 0" },
              },
              smallButton(
                "重置到默认位置",
                function () {
                  resetFishPos();
                },
                cardBusy,
              ),
            ),
            React.createElement(
              "div",
              {
                key: "hint",
                style: { marginTop: "8px", fontSize: "11px", color: "#64748b", lineHeight: 1.5 },
              },
              "角色位置自动记忆；单击角色或点 ⚙ 打开本卡片；右键角色同样可用；" +
              "点气泡右上角 × 可隐藏本次气泡，下一轮对话再显示。",
            ),
          )
        : null;

      // 隐藏的 iframe 始终挂载：LiveKit 连接和房间里的 agent 保持运行，
      // 状态与字幕经 postMessage 上报给气泡。
      var hiddenFrame = React.createElement("iframe", {
        key: "frame",
        title: "语音对话",
        src: playgroundUrl(ui.sessionId),
        allow: "microphone; autoplay",
        referrerPolicy: "no-referrer",
        ref: iframeRef,
        style: {
          position: "absolute",
          width: "1px",
          height: "1px",
          border: "0",
          opacity: 0,
          pointerEvents: "none",
          left: "0",
          top: "0",
        },
      });

      return React.createElement(
        "div",
        {
          style: {
            position: "fixed",
            inset: "0",
            zIndex: "2147483100",
            pointerEvents: "none",
          },
        },
        hiddenFrame,
        character,
        bubble,
        card,
      );
    }

    function apply(ctx) {
      var openVoice = function (sessionId) {
        try {
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, {
            detail: { sessionId: sessionId || "" },
          }));
        } catch (error) {
          console.error("Unable to open DSH voice panel", error);
        }
      };
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "voice",
            order: 50,
            inject: function (sessionId) {
              return {
                sessionId,
                onOpen: function () {
                  openVoice(sessionId);
                },
              };
            },
          },
          VoiceAction,
        );
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-voice-popup",
          inject: function () {
            return {};
          },
        }, VoicePopup);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
