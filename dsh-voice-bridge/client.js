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
    };

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

      var characterRef = React.useRef(null);

      var avatarSrc =
        settings.avatar && String(settings.avatar).trim()
          ? String(settings.avatar).trim()
          : AVATAR_SRC;
      var size = settings.fishSize;

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
          if (moved) {
            var rect = characterRef.current ? characterRef.current.getBoundingClientRect() : null;
            var next = rect
              ? { x: Math.round(rect.left), y: Math.round(rect.top) }
              : { x: startPos.x, y: startPos.y };
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

      // 状态 + 字幕：来自嵌入 Playground iframe 的 postMessage 上报。
      React.useEffect(function () {
        var onMsg = function (event) {
          var data = event && event.data;
          if (data && data.type === STATUS_EVENT) {
            setLive({
              status: String(data.status || ""),
              text: String(data.text || ""),
            });
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

      // —— 气泡（可勾选的内容层）——
      var bubbleLines = [];
      if (settings.showStatus) {
        bubbleLines.push(
          (STATUS_LABELS[live.status] || "空闲") + (live.status === "speaking" ? "…" : ""),
        );
      }
      if (settings.showText && live.text) {
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
      if (bubbleLines.length === 0 && settings.alwaysBubble) {
        bubbleLines.push("空闲");
      }

      var BUBBLE_W = 230;
      var bubbleLeft = fish.x + size / 2 - BUBBLE_W / 2;
      bubbleLeft = Math.max(8, Math.min(bubbleLeft, window.innerWidth - BUBBLE_W - 8));
      var bubbleTop = fish.y - 92;
      if (bubbleTop < 8) bubbleTop = fish.y + size + 10;

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
                  top: bubbleTop + "px",
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
                  zIndex: 3,
                },
              },
              bubbleLines.join("\n"),
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
            checkbox("alwaysBubble", "气泡常显（没有内容时也显示）"),
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
            React.createElement("div", { key: "grp3", style: { fontSize: "11px", color: "#94a3b8", margin: "10px 0 2px" } }, "头像"),
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
              "角色位置自动记忆；单击角色或点 ⚙ 打开本卡片；右键角色同样可用。",
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
