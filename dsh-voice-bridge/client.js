window.__ModuleLoader__.load({
  id: "@local/dsh-voice-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var DEFAULT_URL = "http://127.0.0.1:3000/";
    var OPEN_EVENT = "dsh-voice-popup-open";
    var POS_KEY = "dsh-voice-popup-pos";
    var SIZE_KEY = "dsh-voice-popup-size";
    var MINW = 320, MINH = 380;

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
      var stateHook = React.useState({ open: false, sessionId: "", minimized: false });
      var state = stateHook[0];
      var setState = stateHook[1];
      var layoutHook = React.useState(null);
      var layout = layoutHook[0];
      var sectionRef = React.useRef(null);
      var dragRef = React.useRef(null);
      var dragRef2 = React.useRef(null);
      var rafRef = React.useRef(0);
      var layoutRef = React.useRef(null);

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

      // Drag: move the panel by left/top. Works in both expanded and
      // minimized states — the minimized bar is exactly the handle you grab
      // to move it around without the big panel.
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

      // Resize: adjust width/height from the bottom-right corner
      var startResize = function (event) {
        if (event.button !== 0 || state.minimized) return;
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

      var toggleMinimize = function () {
        setState(function (s) {
          return Object.assign({}, s, { minimized: !s.minimized });
        });
      };

      var closePopup = function () {
        setState({ open: false, sessionId: "", minimized: false });
        layoutRef.current = null;
      };

      React.useEffect(function () {
        var onOpen = function (event) {
          setState({
            open: true,
            sessionId: event.detail && event.detail.sessionId ? String(event.detail.sessionId) : "",
            minimized: false,
          });
        };
        window.addEventListener(OPEN_EVENT, onOpen);
        return function () {
          window.removeEventListener(OPEN_EVENT, onOpen);
        };
      }, []);

      React.useEffect(function () {
        return function () {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
      }, []);

      // When layout is first needed (open & not minimized), position via left/top.
      var currentLayout = (layout || (state.open && !state.minimized ? ensureLayout() : null));

      if (!state.open) return null;

      var sectionStyle = {
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        background: "var(--dsw-alias-bg-base, #111827)",
        border: "1px solid var(--dsw-alias-border-l2, #334155)",
        borderRadius: "8px",
        boxShadow: "0 18px 48px rgba(0,0,0,.32)",
      };

      if (state.minimized) {
        var miniPos = currentLayout ? currentLayout.pos : { x: window.innerWidth - 200, y: window.innerHeight - 64 };
        sectionStyle.width = "180px";
        sectionStyle.height = "44px";
        sectionStyle.left = miniPos.x + "px";
        sectionStyle.top = miniPos.y + "px";
        sectionStyle.right = "auto";
        sectionStyle.bottom = "auto";
      } else {
        if (currentLayout) {
          sectionStyle.left = currentLayout.pos.x + "px";
          sectionStyle.top = currentLayout.pos.y + "px";
          sectionStyle.width = currentLayout.size.width + "px";
          sectionStyle.height = currentLayout.size.height + "px";
        } else {
          // First render: fall back to bottom-right until layout computed
          sectionStyle.right = "20px";
          sectionStyle.bottom = "20px";
          sectionStyle.width = "min(460px, calc(100vw - 32px))";
          sectionStyle.height = "min(640px, calc(100vh - 40px))";
        }
        sectionStyle.right = "auto";
        sectionStyle.bottom = "auto";
      }

      var headerStyle = {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minHeight: "42px",
        padding: "8px 10px",
        borderBottom: state.minimized ? "none" : "1px solid var(--dsw-alias-border-l2, #334155)",
        color: "var(--dsw-alias-label-primary, #f8fafc)",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "move",
        userSelect: "none",
        touchAction: "none",
      };

      var headerButtons = [
        React.createElement(
          "button",
          {
            key: "min",
            type: "button",
            "aria-label": state.minimized ? "展开语音面板" : "最小化语音面板",
            title: state.minimized ? "展开" : "最小化",
            onClick: function (e) {
              e.stopPropagation();
              toggleMinimize();
            },
            onMouseDown: function (e) { e.stopPropagation(); },
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
          state.minimized ? "□" : "—",
        ),
        React.createElement(
          "button",
          {
            key: "close",
            type: "button",
            "aria-label": "关闭语音对话",
            title: "关闭",
            onClick: function (e) {
              e.stopPropagation();
              closePopup();
            },
            onMouseDown: function (e) { e.stopPropagation(); },
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
          React.createElement(
            "span",
            {
              style: { flex: "1", minWidth: "0", cursor: "default" },
              onMouseDown: function (e) { e.stopPropagation(); },
            },
            state.minimized ? "语音" : "语音对话",
          ),
          headerButtons,
        ),
      ];

      // The iframe stays mounted across minimize/restore so the LiveKit
      // connection (and the agent in the room) keeps running. We only hide it
      // visually when the panel is minimized.
      children.push(
        React.createElement("iframe", {
          key: "frame",
          title: "语音对话",
          src: playgroundUrl(state.sessionId),
          allow: "microphone; autoplay",
          referrerPolicy: "no-referrer",
          style: {
            flex: "1 1 auto",
            width: "100%",
            minHeight: "0",
            border: "0",
            background: "#fff",
            display: state.minimized ? "none" : "block",
          },
        }),
      );

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

      // A full-width strip along the bottom edge makes height-resizing much
      // easier to grab than the corner alone.
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
          children.concat(state.minimized ? [] : [grip, bottomStrip]),
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
