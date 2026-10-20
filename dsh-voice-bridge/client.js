window.__ModuleLoader__.load({
  id: "@local/dsh-voice-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var DEFAULT_URL = "http://127.0.0.1:3000/";
    var OPEN_EVENT = "dsh-voice-popup-open";
    var STATUS_EVENT = "dsh-voice-status";
    var POS_KEY = "dsh-voice-popup-pos";
    var SIZE_KEY = "dsh-voice-popup-size";
    var FISH_POS_KEY = "dsh-voice-fish-pos";
    var BUBBLE_KEY = "dsh-voice-bubble";
    var MINW = 320, MINH = 380;
    var AVATAR_SRC = "/voice/avatar.png";
    var BUBBLE_DEFAULTS = {
      showStatus: true,
      showText: true,
      showBalance: true,
      fishSize: 72,
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

    function clampPos(pos, size) {
      var w = window.innerWidth;
      var h = window.innerHeight;
      var x = Math.round(pos.x || 0);
      var y = Math.round(pos.y || 0);
      x = Math.max(0, Math.min(x, Math.max(0, w - 120)));
      y = Math.max(0, Math.min(y, Math.max(0, h - 48)));
      return { x: x, y: y };
    }

    function defaultSize() {
      return {
        width: Math.min(460, window.innerWidth - 32),
        height: Math.min(640, window.innerHeight - 40),
      };
    }

    function clampedSize(size) {
      var w = window.innerWidth;
      var h = window.innerHeight;
      return {
        width: Math.max(MINW, Math.min(Math.round(size.width || 460), w - 16)),
        height: Math.max(MINH, Math.min(Math.round(size.height || 640), h - 16)),
      };
    }

    function defaultPos(size) {
      return {
        x: Math.max(8, Math.round(window.innerWidth - size.width - 20)),
        y: Math.max(8, Math.round(window.innerHeight - size.height - 20)),
      };
    }

    function defaultFishPos(size) {
      var s = Number(size) || 72;
      return {
        x: Math.max(8, Math.round(window.innerWidth - s - 24)),
        y: Math.max(8, Math.round(window.innerHeight - s - 24)),
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
      var uiHook = React.useState({ open: false, sessionId: "", view: "fish" });
      var ui = uiHook[0];
      var setUi = uiHook[1];

      var settingsHook = React.useState(function () {
        var s = Object.assign({}, BUBBLE_DEFAULTS, loadJSON(BUBBLE_KEY, {}));
        s.fishSize = Math.max(56, Math.min(120, Number(s.fishSize) || 72));
        return s;
      });
      var settings = settingsHook[0];
      var setSettings = settingsHook[1];

      var fishPosHook = React.useState(function () {
        return loadJSON(FISH_POS_KEY, null);
      });
      var fishPos = fishPosHook[0];
      var setFishPos = fishPosHook[1];

      var liveHook = React.useState({ status: "", text: "" });
      var live = liveHook[0];
      var setLive = liveHook[1];

      var balanceHook = React.useState(null);
      var balance = balanceHook[0];
      var setBalance = balanceHook[1];

      var settingsOpenHook = React.useState(false);
      var settingsOpen = settingsOpenHook[0];
      var setSettingsOpen = settingsOpenHook[1];

      var layoutHook = React.useState(null);
      var layout = layoutHook[0];
      var sectionRef = React.useRef(null);
      var fishRef = React.useRef(null);
      var rafRef = React.useRef(0);
      var layoutRef = React.useRef(null);

      var avatarSrc =
        settings.avatar && String(settings.avatar).trim()
          ? String(settings.avatar).trim()
          : AVATAR_SRC;
      var fishSize = settings.fishSize;

      var updateSettings = React.useCallback(function (patch) {
        setSettings(function (previous) {
          var next = Object.assign({}, previous, patch);
          saveJSON(BUBBLE_KEY, next);
          return next;
        });
      }, []);

      var initLayout = React.useCallback(function () {
        var size = clampedSize(loadJSON(SIZE_KEY, defaultSize()));
        var pos = clampPos(loadJSON(POS_KEY, null) || defaultPos(size), size);
        return { pos: pos, size: size };
      }, []);

      var setLayout = React.useCallback(function (next) {
        layoutRef.current = next;
        saveJSON(POS_KEY, next.pos);
        saveJSON(SIZE_KEY, next.size);
        layoutHook[1](next);
      }, []);

      var ensureLayout = function () {
        if (!layoutRef.current) layoutRef.current = initLayout();
        return layoutRef.current;
      };

      var schedulePersist = React.useCallback(function () {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(function () {
          rafRef.current = 0;
          var current = layoutRef.current;
          if (!current) return;
          saveJSON(POS_KEY, current.pos);
          saveJSON(SIZE_KEY, current.size);
        });
      }, []);

      // Drag the panel by left/top (expanded view).
      var startDrag = function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        var current = ensureLayout();
        var target = sectionRef.current;
        if (!target) return;
        var startX = event.clientX;
        var startY = event.clientY;
        var startPos = { x: current.pos.x, y: current.pos.y };
        var moved = false;
        target.style.left = current.pos.x + "px";
        target.style.top = current.pos.y + "px";
        target.style.right = "auto";
        target.style.bottom = "auto";

        var onMove = function (ev) {
          var dx = ev.clientX - startX;
          var dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) > 2) moved = true;
          if (!moved) return;
          var next = {
            x: Math.max(0, Math.min(startPos.x + dx, window.innerWidth - 120)),
            y: Math.max(0, Math.min(startPos.y + dy, window.innerHeight - 48)),
          };
          target.style.left = next.x + "px";
          target.style.top = next.y + "px";
          layoutRef.current = { pos: next, size: current.size };
          schedulePersist();
        };
        var onUp = function () {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (moved) {
            var cur = layoutRef.current;
            layoutHook[1](cur);
            saveJSON(POS_KEY, cur.pos);
            saveJSON(SIZE_KEY, cur.size);
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      // Resize the expanded panel from the bottom-right corner / bottom edge.
      var startResize = function (event) {
        if (event.button !== 0 || ui.view !== "panel") return;
        event.preventDefault();
        event.stopPropagation();
        var current = ensureLayout();
        var target = sectionRef.current;
        if (!target) return;
        var startX = event.clientX;
        var startY = event.clientY;
        var startW = current.size.width;
        var startH = current.size.height;

        var onMove = function (ev) {
          var w = Math.max(MINW, Math.min(startW + (ev.clientX - startX), window.innerWidth - 16));
          var h = Math.max(MINH, Math.min(startH + (ev.clientY - startY), window.innerHeight - 16));
          target.style.width = w + "px";
          target.style.height = h + "px";
          layoutRef.current = { pos: current.pos, size: { width: w, height: h } };
          schedulePersist();
        };
        var onUp = function () {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          var cur = layoutRef.current;
          layoutHook[1](cur);
          saveJSON(POS_KEY, cur.pos);
          saveJSON(SIZE_KEY, cur.size);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      // Compact "fish ball" view: drag to move, click (no move) to expand,
      // right-click for the settings popover.
      var startFishDrag = function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        var target = fishRef.current;
        if (!target) return;
        var startPos = fishPos || defaultFishPos(fishSize);
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
            x: Math.max(0, Math.min(startPos.x + dx, window.innerWidth - fishSize)),
            y: Math.max(0, Math.min(startPos.y + dy, window.innerHeight - fishSize)),
          };
          target.style.left = next.x + "px";
          target.style.top = next.y + "px";
        };
        var onUp = function () {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (moved) {
            var targetRect = fishRef.current ? fishRef.current.getBoundingClientRect() : null;
            var next = targetRect
              ? { x: Math.round(targetRect.left), y: Math.round(targetRect.top) }
              : { x: startPos.x, y: startPos.y };
            setFishPos(next);
            saveJSON(FISH_POS_KEY, next);
          } else {
            setUi(function (previous) {
              return Object.assign({}, previous, { view: "panel" });
            });
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      var collapseToFish = function () {
        setUi(function (previous) {
          return Object.assign({}, previous, { view: "fish" });
        });
      };

      var openSettings = function () {
        setSettingsOpen(true);
      };

      var closePopup = function () {
        setUi({ open: false, sessionId: "", view: "fish" });
        layoutRef.current = null;
        setSettingsOpen(false);
      };

      React.useEffect(function () {
        var onOpen = function (event) {
          setUi({
            open: true,
            sessionId: event.detail && event.detail.sessionId ? String(event.detail.sessionId) : "",
            view: "fish",
          });
        };
        window.addEventListener(OPEN_EVENT, onOpen);
        return function () {
          window.removeEventListener(OPEN_EVENT, onOpen);
        };
      }, []);

      // Live status + subtitles posted from the embedded Playground iframe.
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

      // DeepSeek balance, served by this plugin's own host route
      // (`/voice/balance.json`): API-key route first, then the DSH
      // account-login route, plus a tiny daily ledger for "used today".
      // Degrades to "hidden" when no credential is available.
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

      React.useEffect(function () {
        return function () {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
      }, []);

      var currentLayout =
        layout || (ui.open && ui.view === "panel" ? ensureLayout() : null);

      if (!ui.open) return null;

      var sectionStyle = {
        position: "absolute",
        display: ui.view === "panel" ? "flex" : "none",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        background: "var(--dsw-alias-bg-base, #111827)",
        border: "1px solid var(--dsw-alias-border-l2, #334155)",
        borderRadius: "8px",
        boxShadow: "0 18px 48px rgba(0,0,0,.32)",
      };

      if (currentLayout) {
        sectionStyle.left = currentLayout.pos.x + "px";
        sectionStyle.top = currentLayout.pos.y + "px";
        sectionStyle.width = currentLayout.size.width + "px";
        sectionStyle.height = currentLayout.size.height + "px";
        sectionStyle.right = "auto";
        sectionStyle.bottom = "auto";
      } else {
        sectionStyle.right = "20px";
        sectionStyle.bottom = "20px";
        sectionStyle.width = "min(460px, calc(100vw - 32px))";
        sectionStyle.height = "min(640px, calc(100vh - 40px))";
      }

      var headerStyle = {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minHeight: "42px",
        padding: "8px 10px",
        borderBottom: "1px solid var(--dsw-alias-border-l2, #334155)",
        color: "var(--dsw-alias-label-primary, #f8fafc)",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "move",
        userSelect: "none",
        touchAction: "none",
      };

      var stopMouseDown = function (event) {
        event.stopPropagation();
      };

      var headerButtons = [
        React.createElement(
          "button",
          {
            key: "min",
            type: "button",
            "aria-label": "折叠成小鱼球",
            title: "折叠成小鱼球",
            onClick: function (event) {
              event.stopPropagation();
              collapseToFish();
            },
            onMouseDown: stopMouseDown,
            style: {
              appearance: "none",
              border: "0",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: "14px",
              lineHeight: "1",
              padding: "4px 6px",
            },
          },
          "—",
        ),
        React.createElement(
          "button",
          {
            key: "gear",
            type: "button",
            "aria-label": "伴随设置",
            title: "气泡层 / 头像 / 大小",
            onClick: function (event) {
              event.stopPropagation();
              openSettings();
            },
            onMouseDown: stopMouseDown,
            style: {
              appearance: "none",
              border: "0",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: "14px",
              lineHeight: "1",
              padding: "4px 6px",
            },
          },
          "⚙",
        ),
        React.createElement(
          "button",
          {
            key: "close",
            type: "button",
            "aria-label": "关闭语音对话",
            title: "关闭",
            onClick: function (event) {
              event.stopPropagation();
              closePopup();
            },
            onMouseDown: stopMouseDown,
            style: {
              appearance: "none",
              border: "0",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: "16px",
              lineHeight: "1",
              padding: "4px 6px",
            },
          },
          "x",
        ),
      ];

      var children = [
        React.createElement(
          "header",
          {
            key: "header",
            style: headerStyle,
            onMouseDown: startDrag,
          },
          React.createElement("img", {
            key: "whale",
            src: avatarSrc,
            alt: "",
            draggable: false,
            onMouseDown: stopMouseDown,
            style: {
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              objectFit: "cover",
              flex: "0 0 auto",
              pointerEvents: "none",
              userSelect: "none",
              background: "#1e293b",
            },
          }),
          React.createElement(
            "span",
            {
              key: "title",
              style: { flex: "1", minWidth: "0", cursor: "default" },
              onMouseDown: stopMouseDown,
            },
            "语音对话",
          ),
          headerButtons,
        ),
      ];

      // The iframe stays mounted across fish/panel views so the LiveKit
      // connection (and the agent in the room) keeps running. It is only
      // hidden visually when the panel is collapsed into the fish ball.
      children.push(
        React.createElement("iframe", {
          key: "frame",
          title: "语音对话",
          src: playgroundUrl(ui.sessionId),
          allow: "microphone; autoplay",
          referrerPolicy: "no-referrer",
          style: {
            flex: "1 1 auto",
            width: "100%",
            minHeight: "0",
            border: "0",
            background: "#fff",
            display: ui.view === "panel" ? "block" : "none",
          },
        }),
      );

      if (ui.view === "panel") {
        var grip = React.createElement(
          "div",
          {
            key: "grip",
            role: "presentation",
            title: "按住拖动调整大小",
            onMouseDown: startResize,
            style: {
              position: "absolute",
              right: "0",
              bottom: "0",
              width: "28px",
              height: "28px",
              cursor: "nwse-resize",
              zIndex: 4,
              pointerEvents: "auto",
              boxSizing: "border-box",
              borderRight: "3px solid var(--dsw-alias-label-secondary, #64748b)",
              borderBottom: "3px solid var(--dsw-alias-label-secondary, #64748b)",
              background:
                "repeating-linear-gradient(135deg, transparent 0, transparent 4px, var(--dsw-alias-label-secondary, #64748b) 4px, var(--dsw-alias-label-secondary, #64748b) 7px)",
              backgroundSize: "14px 14px",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 2px bottom 2px",
              opacity: 0.95,
            },
          },
          null,
        );

        var bottomStrip = React.createElement(
          "div",
          {
            key: "strip",
            role: "presentation",
            title: "上下拖动调整高度",
            onMouseDown: startResize,
            style: {
              position: "absolute",
              left: "0",
              right: "28px",
              bottom: "0",
              height: "8px",
              cursor: "ns-resize",
              zIndex: 3,
              pointerEvents: "auto",
              borderBottom: "2px solid transparent",
            },
          },
          null,
        );
        children.push(grip, bottomStrip);
      }

      // —— 小鱼球（compact companion view）——
      if (ui.view === "fish") {
        var fish = fishPos || defaultFishPos(fishSize);
        var statusKey = STATUS_COLORS[live.status] ? live.status : "idle";
        var fishEl = React.createElement(
          "div",
          {
            key: "fish",
            ref: fishRef,
            onMouseDown: startFishDrag,
            onContextMenu: function (event) {
              event.preventDefault();
              event.stopPropagation();
              openSettings();
            },
            title: "单击展开面板 · 拖动移动 · 右键设置",
            style: {
              position: "absolute",
              left: fish.x + "px",
              top: fish.y + "px",
              width: fishSize + "px",
              height: fishSize + "px",
              borderRadius: "50%",
              overflow: "hidden",
              cursor: "grab",
              pointerEvents: "auto",
              border: "2px solid #475569",
              boxShadow: "0 10px 28px rgba(0,0,0,.5)",
              background: "#1e293b",
              zIndex: 3,
            },
          },
          React.createElement("img", {
            src: avatarSrc,
            alt: "语音",
            draggable: false,
            style: {
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              pointerEvents: "none",
              userSelect: "none",
            },
          }),
          React.createElement("span", {
            style: {
              position: "absolute",
              right: "6%",
              bottom: "6%",
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: STATUS_COLORS[statusKey],
              border: "2px solid #fff",
            },
          }),
        );
        children.push(fishEl);

        // —— 气泡（可勾选的内容层）——
        var bubbleLines = [];
        if (settings.showStatus) {
          bubbleLines.push(
            (STATUS_LABELS[live.status] || "空闲") +
              (live.status === "speaking" ? "…" : ""),
          );
        }
        if (settings.showText && live.text) {
          bubbleLines.push(live.text.length > 80 ? "…" + live.text.slice(-77) : live.text);
        }
        if (settings.showBalance && balance) {
          bubbleLines.push(
            "余额 ¥" + fmtMoney(balance.totalBalance) +
              " · 今日 ¥" + fmtMoney(balance.todayUsage),
          );
        }
        if (bubbleLines.length > 0) {
          var BUBBLE_W = 220;
          var bubbleLeft = fish.x + fishSize + 10;
          if (bubbleLeft + BUBBLE_W > window.innerWidth - 8) {
            bubbleLeft = Math.max(8, fish.x - BUBBLE_W - 10);
          }
          var bubbleTop = Math.max(8, fish.y - 6);
          children.push(
            React.createElement(
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
                  zIndex: 2,
                },
              },
              bubbleLines.join("\n"),
            ),
          );
        }
      }

      // —— 设置浮层 ——
      if (settingsOpen) {
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
        var fileButton = React.createElement(
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
        children.push(
          React.createElement(
            "div",
            {
              key: "settings",
              role: "dialog",
              "aria-label": "伴随设置",
              style: {
                position: "absolute",
                top: "16px",
                right: "16px",
                width: "264px",
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: "10px",
                padding: "12px",
                zIndex: 5,
                pointerEvents: "auto",
                color: "#e2e8f0",
                boxShadow: "0 18px 48px rgba(0,0,0,.4)",
              },
            },
            React.createElement(
              "div",
              {
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
                    setSettingsOpen(false);
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
            checkbox("showStatus", "气泡显示语音状态（空闲/聆听/思考/播报）"),
            checkbox("showText", "气泡显示 Agent 实时字幕"),
            checkbox("showBalance", "气泡显示 DeepSeek 余额 / 今日已用"),
            React.createElement(
              "div",
              {
                key: "size",
                style: { margin: "10px 0 2px", fontSize: "12px" },
              },
              "小鱼球大小：",
              String(fishSize) + "px",
              React.createElement("input", {
                type: "range",
                min: "56",
                max: "120",
                step: "4",
                value: String(fishSize),
                style: { width: "140px", verticalAlign: "middle" },
                onChange: function (event) {
                  updateSettings({ fishSize: Number(event.target.value) });
                },
              }),
            ),
            React.createElement(
              "div",
              {
                key: "avatar",
                style: { margin: "8px 0 2px", fontSize: "12px" },
              },
              "头像：默认鲸鱼娘，可换成你自己的图",
              React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: "6px",
                    marginTop: "6px",
                    alignItems: "center",
                  },
                },
                React.createElement("img", {
                  src: avatarSrc,
                  alt: "当前头像",
                  style: {
                    width: "36px",
                    height: "36px",
                    borderRadius: "50%",
                    objectFit: "cover",
                    background: "#1e293b",
                    flex: "0 0 auto",
                  },
                }),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: function () {
                      var el = document.getElementById("dsh-voice-avatar-file");
                      if (el && el.click) el.click();
                    },
                    style: {
                      appearance: "none",
                      border: "1px solid #475569",
                      borderRadius: "6px",
                      background: "#1e293b",
                      color: "#e2e8f0",
                      cursor: "pointer",
                      fontSize: "12px",
                      padding: "4px 8px",
                    },
                  },
                  "导入图片",
                ),
                settings.avatar
                  ? React.createElement(
                      "button",
                      {
                        type: "button",
                        onClick: function () {
                          updateSettings({ avatar: "" });
                        },
                        style: {
                          appearance: "none",
                          border: "1px solid #475569",
                          borderRadius: "6px",
                          background: "transparent",
                          color: "#94a3b8",
                          cursor: "pointer",
                          fontSize: "12px",
                          padding: "4px 8px",
                        },
                      },
                      "恢复默认",
                    )
                  : null,
              ),
              fileButton,
            ),
            React.createElement(
              "div",
              {
                key: "hint",
                style: {
                  marginTop: "8px",
                  fontSize: "11px",
                  color: "#64748b",
                  lineHeight: 1.5,
                },
              },
              "小鱼球位置自动记忆；面板拖动 / 缩放位置同样自动记忆。",
            ),
          ),
        );
      }

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
        React.createElement(
          "section",
          {
            key: "panel",
            ref: sectionRef,
            role: "dialog",
            "aria-label": "语音对话",
            style: sectionStyle,
          },
          children,
        ),
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
