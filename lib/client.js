/**
 * 提示词优化 —— 浏览器侧。
 *
 * 老大 2026-10-17 / 10-18 原话（按提出顺序）：
 *  「能不能做成我下方UI界面的一个小按钮？按了之后，上方会出现另一个界面。」
 *  「就那个插件的界面，放原来位置的从左边往右数的第四个部分。」
 *  「普通提示词和人设那里根本没区别。并且你那个按键太过雷霆了。」
 *  「做个明显点的标志吧？…深色模式打开那个界面却还是白色的。」
 *  「模型接入那里，按照提供方来进行划分。点击提供方才会显示出提供的模型。」
 *  「点击优化的话也没有什么动画之类的…并且你下面现在根本就没有按钮。」
 *  「多听一个技能，结合上下文理解我们现在干什么，再进行优化。」
 *  「优化以后的内容，如果不满意…只有两个界面，分别是填入输入框和复制。」
 *  「插件的界面还是太单调了。而且上下文你搞详细一点。并且每次我按填入进输入框
 *    里面的时候都会卡。并且并没有填入到输入框里面。」
 *
 * ── 2026-11-25 本轮修复（对应审查报告） ────────────────────────────────
 * ① 关面板/重开丢内容：老代码每次点按钮都 out/err/src 全清，而且关面板
 *    不取消请求、结果回来没人收。现在：请求带 requestId，重开面板不清结果，
 *    最近一次结果按会话写 sessionStorage，重开/刷新都能恢复。
 * ② 退页面必失败：根因在后端把 LLM 流绑在 HTTP 连接上（已改后端）。
 *    前端另加显式取消（AbortController + POST /cancel + Esc）。
 * ③ 三种模式：同一批 chip 以前在 iterate 下落 req、在其他模式下落 src，
 *    同一个控件两种语义。现在所有模式的「补充要求」都只写 req，
 *    作为额外要求发给模型，绝不污染待改写正文。
 * ④ 主按钮被遮挡：主操作行紧跟在输入框下面（第一屏就能看见）。
 * ⑤ 可观测性：结果显示耗时/字数/token/结束原因，可展开看实际发送内容与思考过程。
 * ⑥ 模型选择：默认收起成一行，展开是带搜索的分组列表，显示说明与能力标记；
 *    非文本模型（生图/嵌入/语音等）前后端都不再出现。
 * ⑦ 长上下文：超过 12000 字先由后端摘要再改写，结果里说明「多少字压成多少字、
 *    摘要花了多久」；按钮在等待时改文案，避免用户以为卡死。
 * ⑧ 纯文本输出：三个模式都不要求 Markdown，模型侧已加禁 Markdown 规则，
 *    前端不再对结果做任何 Markdown 渲染，直接 pre-wrap 显示。
 * ⑨ 摘要失败要可见：后端退回原文时必须回 summaryFailed，前端写「压缩失败，已按原文发送」。
 *
 * 填入输入框仍然走 Lexical 公开 API（见下面 writeDraft 的三条路）。
 *
 * 位置：按钮在 `conversation.input.left`（输入栏左侧第 4 格），
 * 面板在 `conversation.input.dock`（输入框正上方）。两个 slot 是独立组件，
 * 状态放模块级 store，谁改都通知两边重渲染。
 */

window.__ModuleLoader__.load({
  id: "dsh-prompt-optimize-button",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsx = require("react/jsx-runtime").jsx;
    const jsxs = require("react/jsx-runtime").jsxs;
    const { useState, useEffect, useRef } = react;

    // 面板要 portal 到 body，否则永远可能被悬浮类插件（宠物立绘、挂件）压住。
    // 宿主自己的 ContextMeter 就是这么做的（createPortal + position:fixed）。
    // react-dom 在宿主种子模块表里，取不到时退回原地渲染，不影响功能。
    // 种子表给的是 ESM namespace（__toESM 包了一层），createPortal 可能只在
    // .default 上，两处都要看。注意用 typeof 判断存不存在，别用 || ——
    // 都是函数引用，写错也不会报错，只会静默退化。
    let createPortal = null;
    try {
      const reactDom = require("react-dom");
      if (reactDom) {
        if (typeof reactDom.createPortal === "function") createPortal = reactDom.createPortal;
        else if (reactDom.default && typeof reactDom.default.createPortal === "function") {
          createPortal = reactDom.default.createPortal;
        }
      }
    } catch (e) {
      createPortal = null;
    }

    const BASE = "/prompt-optimize-button-api";
    const API = BASE + "/optimize";
    const SAVE_KEY = "dpo:last";

    // ── 动画 ────────────────────────────────────────────────────────────────
    const CSS = `
@keyframes dpo-spin{to{transform:rotate(360deg)}}
@keyframes dpo-in{from{opacity:0;transform:translateY(10px) scale(.994)}to{opacity:1;transform:none}}
@keyframes dpo-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes dpo-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes dpo-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.dpo-panel{animation:dpo-in .22s cubic-bezier(.2,.8,.3,1) both}
.dpo-out{animation:dpo-fade .26s ease-out both}
.dpo-list{animation:dpo-fade .14s ease-out both}
.dpo-btn{transition:background .15s ease,color .15s ease,border-color .15s ease,transform .12s ease,box-shadow .15s ease}
.dpo-btn:active{transform:scale(.965)}
.dpo-chip{transition:background .14s ease,color .14s ease,border-color .14s ease}
.dpo-skel{background:linear-gradient(90deg,rgba(127,127,127,.10) 25%,rgba(127,127,127,.28) 37%,rgba(127,127,127,.10) 63%);background-size:200% 100%;animation:dpo-shimmer 1.15s linear infinite;border-radius:6px}
.dpo-dot{animation:dpo-pulse 1.6s ease-in-out infinite}
.dpo-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
/* 窄屏：列表高度、内边距要收，否则手机上结果区只剩两三行。
   注意别在这里写 .dpo-panel 的 max-height!important —— 面板是 portal 出去的
   fixed 元素，高度由 panelAnchor() 按输入框位置算好写在行内，覆盖掉就会压住输入框。 */
@media (max-width:560px){
  .dpo-panel{border-radius:14px!important}
  .dpo-list{max-height:38vh!important}
  .dpo-out{max-height:30vh!important}
  .dpo-item{padding:9px 10px!important}
}
`;

    /* 注入样式，并返回一个卸载函数；调用方（apply）把它交给 ctx.effect 持有，
       这样禁用插件时样式跟着走，不会在 head 里留一条没人认领的 <style>。
       已经存在时返回空函数 —— 不是自己建的节点，就不该由自己删。 */
    function ensureCSS() {
      try {
        if (document.getElementById("dpo-css")) return function () {};
        const st = document.createElement("style");
        st.id = "dpo-css";
        st.textContent = CSS;
        document.head.appendChild(st);
        return function () {
          try { if (st.parentNode) st.parentNode.removeChild(st); } catch (e) { /* 忽略 */ }
        };
      } catch (e) {
        return function () {};
      }
    }

    // ── 非文本模型：与后端 lib/index.js 的 NON_TEXT 保持同一份规则 ───────────
    const NON_TEXT = /(gpt-?image|dall-?e|(^|[-_/.])(image|imagen|flux|midjourney|sdxl|stable-diffusion|tts|whisper|audio|speech|embedding|embed|rerank|moderation)([-_/.]|$))/i;
    function isNonText(m) {
      return NON_TEXT.test(String((m && m.id) || "")) || NON_TEXT.test(String((m && m.name) || ""));
    }

    // ── 共享状态 ────────────────────────────────────────────────────────────
    const store = {
      open: false,
      mode: "user",
      src: "",
      req: "",
      out: "",
      meta: null,
      debug: null,
      showDebug: false,
      busy: false,
      err: "",
      note: "",
      requestId: "",
      elapsed: 0,
      stale: false,
      providers: null,
      hiddenModels: 0,
      modelsLoading: false,
      modelsError: "",
      modelsNotice: "",
      failedProviders: [],
      pickerOpen: false,
      pickQuery: "",
      contextSession: null,
      ctxLen: 0,
      boundSession: null,
      prov: "",
      model: "",
      modelSelected: false,
      _subs: new Set(),
      set(patch) {
        Object.assign(store, patch);
        for (const fn of [...store._subs]) fn();
      },
      sub(fn) {
        store._subs.add(fn);
        return () => store._subs.delete(fn);
      },
    };

    function useStore() {
      const [, force] = useState(0);
      useEffect(() => store.sub(() => force((n) => n + 1)), []);
      return store;
    }

    // ── 最近一次结果的本地留存（重开面板/刷新后可恢复）────────────────────────
    function saveLast() {
      try {
        if (!store.out) return;
        sessionStorage.setItem(SAVE_KEY, JSON.stringify({
          sessionId: store.boundSession || "",
          src: store.src, req: store.req, mode: store.mode,
          out: store.out, meta: store.meta,
        }));
      } catch (e) { /* 隐私模式下 sessionStorage 可能不可用 */ }
    }

    function readLast() {
      try {
        const raw = sessionStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value.out === "string" ? value : null;
      } catch (e) { return null; }
    }

    // ── 读写 composer ──────────────────────────────────────────────────────
    function composerEl() {
      const marked = document.querySelector('[data-composer-input]');
      if (marked) {
        const inner = marked.matches('[contenteditable="true"]')
          ? marked
          : marked.querySelector('[contenteditable="true"]');
        if (inner && inner.offsetParent !== null) return inner;
      }
      const els = document.querySelectorAll('[contenteditable="true"]');
      for (let i = els.length - 1; i >= 0; i--) {
        if (els[i].offsetParent !== null) return els[i];
      }
      return els[els.length - 1] || null;
    }

    function readDraft() {
      const el = composerEl();
      if (!el) return "";
      return String(el.innerText || "").replace(/\u00a0/g, " ").replace(/\n{2,}$/, "").trim();
    }

    // Lexical 的节点 JSON。只造 core 节点（paragraph + text），
    // 这两个是 Lexical 内置的，任何配置下都注册着。
    function lexicalState(text) {
      const lines = String(text).split(/\r?\n/);
      return {
        root: {
          children: lines.map((line) => ({
            children: line
              ? [{
                  detail: 0, format: 0, mode: "normal", style: "",
                  text: line, type: "text", version: 1,
                }]
              : [],
            direction: "ltr", format: "", indent: 0,
            type: "paragraph", version: 1, textFormat: 0, textStyle: "",
          })),
          direction: "ltr", format: "", indent: 0, type: "root", version: 1,
        },
      };
    }

    // 三条路，按可靠性排序：
    //   A. Lexical 实例（正解）：改 editorState，DOM 由 Lexical 自己渲染
    //   B. 粘贴事件：Lexical 有 PASTE_COMMAND，会读 clipboardData
    //   C. execCommand：老路，只在 A/B 都不成立时兜底
    function writeDraft(text) {
      const el = composerEl();
      if (!el) return { ok: false, how: "找不到输入框" };
      const want = String(text).trim();

      try {
        const ed = el.__lexicalEditor;
        if (ed && typeof ed.parseEditorState === "function" && typeof ed.setEditorState === "function") {
          const state = ed.parseEditorState(lexicalState(text));
          el.focus();
          ed.setEditorState(state);
          if (readDraft() === want) return { ok: true, how: "lexical" };
        }
      } catch (e) { /* 落到 B */ }

      try {
        el.focus();
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        let ev;
        try {
          ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        } catch (e) {
          ev = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(ev, "clipboardData", { value: dt });
        }
        try { document.execCommand("selectAll", false, null); } catch (e) { /* 忽略 */ }
        el.dispatchEvent(ev);
        if (readDraft() === want) return { ok: true, how: "paste" };
      } catch (e) { /* 落到 C */ }

      try {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, text);
        if (readDraft() === want) return { ok: true, how: "execCommand" };
      } catch (e) { /* 全失败 */ }

      return { ok: false, how: "三种写法都没写进去", actual: readDraft().slice(0, 40) };
    }

    // 只读当前输入栏所属会话里真正渲染出来的消息。
    // 上限与后端一致（24000 字）；截断时明确告知，不再整次请求失败。
    const CTX_LIMIT = 24000;
    const CTX_SAFE = 23000;
    const CTX_ELLIPSIS = "…（更早内容已省略）\n\n";

    function readContext(sessionId) {
      if (!sessionId) return "";
      const root = Array.from(document.querySelectorAll("[data-conversation-content][data-conversation-session]"))
        .find((el) => el.dataset.conversationSession === sessionId && el.getClientRects().length);
      if (!root) return "";
      const nodes = root.querySelectorAll('[data-chat-node-key][data-chat-turn]:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"],[data-chat-flow-kind="assistant-step"])');
      const turns = new Map();
      const seen = new Set();
      const parts = [];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.closest('[hidden],[data-turn-process-hidden],[data-chat-group-part="reasoning"]') || !node.getClientRects().length) continue;
        const key = node.dataset.chatNodeKey;
        if (seen.has(key)) continue;
        const assistant = node.dataset.chatFlowKind === "assistant-step";
        const selector = assistant ? '[data-text-interaction-source]' : '[data-message-bubble]';
        const text = Array.from(node.querySelectorAll(selector))
          .filter((el) => !el.closest('[hidden],[data-turn-process-inline],[data-variant="think"]') && el.getClientRects().length)
          .map((el) => el.innerText.trim()).filter(Boolean).join("\n\n");
        if (!text) continue;
        seen.add(key);
        const turn = node.dataset.chatTurn;
        if (!turns.has(turn)) {
          if (turns.size === 12) break;
          turns.set(turn, []);
        }
        turns.get(turn).unshift((assistant ? "【助手】\n" : "【我】\n") + text);
      }
      for (const turn of turns.values()) {
        const block = turn.join("\n\n");
        const existing = parts.join("\n\n");
        const room = CTX_SAFE - CTX_ELLIPSIS.length;
        if (block.length + existing.length + (existing ? 2 : 0) > room) {
          if (!parts.length) {
            // 最后一轮就超长：保留头部，末尾标截断，总长严格 ≤ CTX_SAFE
            const suffix = "\n…（本轮已截断）";
            let end = room - suffix.length;
            if (/[\uD800-\uDBFF]/.test(block[end - 1])) end -= 1;
            return block.slice(0, Math.max(0, end)) + suffix;
          }
          return CTX_ELLIPSIS + existing;
        }
        parts.unshift(block);
      }
      return parts.join("\n\n");
    }

    // ── 模型目录 ───────────────────────────────────────────────────────────
    async function loadProviders() {
      if (store.modelsLoading) return;
      store.set({ modelsLoading: true, modelsError: "", modelsNotice: "" });
      try {
        const r = await fetch(BASE + "/providers", { signal: AbortSignal.timeout(30_000), cache: "no-store" });
        const j = await r.json().catch(() => null);
        if (r.status === 404) throw new Error("DSH 尚未加载新的优化服务，请重启 DSH Web 后刷新页面。");
        if (!r.ok || !j?.ok || !Array.isArray(j.providers)) throw new Error(j?.error || "无法读取 DSH 模型目录。");
        // 后端已经过滤过一遍，这里再挡一次：两边规则必须一致。
        let dropped = 0;
        const list = j.providers
          .filter((p) => Array.isArray(p?.models) && p.models.length)
          .map((p) => ({
            ...p,
            models: p.models.filter((m) => {
              if (isNonText(m)) { dropped += 1; return false; }
              return true;
            }),
          }))
          .filter((p) => p.models.length);
        // 后端也会计数；取两者较大的，避免后端没返回该字段（旧版/降级）时
        // 前端已经把模型藏了却不告诉用户。
        const hidden = Math.max(Number(j.hiddenModels) || 0, dropped);
        const valid = list.some((p) => p.id === store.prov && p.models.some((m) => m.id === store.model));
        const defaultGroup = list.find((p) => p.id === j.default?.provider && p.models.some((m) => m.id === j.default?.model));
        const initial = store.modelSelected || store.model ? null : defaultGroup ? j.default : null;
        const failed = Array.isArray(j.failedProviders) ? j.failedProviders : [];
        const notes = [];
        if (failed.length) notes.push(`${failed.length} 个提供方的模型目录未能加载，其余模型可以正常选择。`);
        if (hidden) notes.push(`已隐藏 ${hidden} 个非文本模型。`);
        // 默认模型被过滤掉时后端会改选第一个可用模型，这里说明一句，
        // 免得用户以为插件擅自换了他的模型。
        if (j.defaultAdjusted) notes.push(`默认模型不可用于文本改写，已改用 ${j.default?.model || "第一个可用模型"}。`);
        store.set({
          providers: list, modelsLoading: false,
          hiddenModels: hidden, failedProviders: failed,
          prov: valid ? store.prov : initial?.provider || "",
          model: valid ? store.model : initial?.model || "",
          modelsError: list.length ? "" : failed.length ? "没有加载到可用模型。请检查 DSH 的模型提供方配置后重试。" : "DSH 暂无可用文本模型。",
          modelsNotice: list.length ? notes.join(" ") : "",
        });
      } catch (error) {
        const message = error.name === "TimeoutError" ? "读取 DSH 模型目录超时，请重试。" : error.message;
        store.set({ providers: [], modelsLoading: false, modelsError: message || "无法读取 DSH 模型目录。" });
      }
    }

    // ── 调后端 ─────────────────────────────────────────────────────────────
    let inflight = null;
    let timer = null;
    // 本次请求开始前的结果快照，失败/取消时归还给用户。
    let lastPrev = null;

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    async function cancel() {
      const id = store.requestId;
      if (inflight) { try { inflight.abort(); } catch (e) { /* 忽略 */ } }
      if (id) {
        try {
          await fetch(BASE + "/cancel", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: id }),
          });
        } catch (e) { /* 后端可能已经结束 */ }
      }
      stopTimer();
      const back = lastPrev && lastPrev.out && !store.out ? lastPrev : null;
      lastPrev = null;
      store.set({
        busy: false, requestId: "", err: "已取消这次优化。",
        ...(back ? { out: back.out, meta: back.meta, debug: back.debug, stale: true } : {}),
      });
    }

    async function optimize(sessionId) {
      if (store.busy || store.modelsLoading || store.modelsError || !store.model) return;
      const live = readDraft();
      const text = (store.src && store.src.trim()) || live;
      if (!text) {
        store.set({ err: "输入框和上面的内容框都是空的，先写点东西。" });
        return;
      }
      const ctx = sessionId && store.contextSession === sessionId ? readContext(sessionId) : "";
      const requestId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const controller = new AbortController();
      inflight = controller;
      const startedAt = Date.now();
      stopTimer();
      timer = setInterval(() => {
        if (store.busy) store.set({ elapsed: Date.now() - startedAt });
      }, 250);
      // 上一次的结果先留一份：这次失败或被取消时还得还给用户，
      // 否则「再点一次」就等于把已经拿到的结果扔了。
      const prev = { out: store.out, meta: store.meta, debug: store.debug };
      lastPrev = prev;
      store.set({
        busy: true, err: "", note: "", out: "", meta: null, debug: null,
        showDebug: false, ctxLen: ctx.length, requestId, elapsed: 0,
        boundSession: sessionId || null, stale: false,
      });
      try {
        const r = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            text,
            mode: store.mode,
            requirements: store.req,
            context: ctx || undefined,
            provider: store.prov || undefined,
            model: store.model || undefined,
            modelName: (currentModel(sessionId) || {}).name || undefined,
            debug: true,
            requestId,
          }),
        });
        const j = await r.json().catch(() => ({ ok: false, error: "后端返回的不是 JSON" }));
        if (!j.ok) {
          const error = new Error(j.error || "优化失败");
          error.code = j.code || "";
          throw error;
        }
        stopTimer();
        lastPrev = null;
        store.set({
          out: j.text, meta: j.meta || null, busy: false, stale: false,
          elapsed: (j.meta && j.meta.elapsedMs) || Date.now() - startedAt,
        });
        saveLast();
      } catch (e) {
        stopTimer();
        const aborted = (e && e.name === "AbortError") || (e && e.code === "cancelled");
        // 这次没成功，把上一次的结果还回去，别让用户白等一场还丢了旧稿。
        const back = lastPrev && lastPrev.out && !store.out ? lastPrev : null;
        lastPrev = null;
        store.set({
          busy: false,
          err: aborted ? "已取消这次优化。" : "优化失败：" + String((e && e.message) || e),
          ...(back ? { out: back.out, meta: back.meta, debug: back.debug, stale: true } : {}),
        });
      } finally {
        if (inflight === controller) inflight = null;
      }
    }

    function currentModel() {
      const group = (store.providers || []).find((p) => p.id === store.prov);
      const model = group && group.models.find((m) => m.id === store.model);
      return model || null;
    }

    // ── 主题色 ─────────────────────────────────────────────────────────────
    const C = {
      bg: "var(--dsw-alias-bg-base, Canvas)",
      bg2: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.10))",
      fg: "var(--dsw-alias-label-primary, CanvasText)",
      fg2: "var(--dsw-alias-label-secondary, CanvasText)",
      fg3: "var(--dsw-alias-label-tertiary, GrayText)",
      line: "var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
      line3: "var(--dsw-alias-border-l3, rgba(127,127,127,.20))",
      line4: "var(--dsw-alias-border-l4, rgba(127,127,127,.14))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))",
      accent: "var(--dsw-alias-state-business-primary, #4d6bfe)",
      accent3: "var(--dsw-alias-state-business-tertiary, rgba(77,107,254,.16))",
      danger: "var(--dsw-alias-state-error-primary, #d33)",
    };

    const S = {
      // 输入栏那一排全是 28×28 的图标按钮（宿主自己的 .add 就是这套几何），
      // 这里保持一致：正圆、无边框、grid 居中、宽度不随文字变。
      btn: {
        display: "grid", placeItems: "center",
        width: 28, height: 28, flex: "none", padding: 0, margin: 0,
        borderRadius: 999, border: "none",
        background: "var(--dsw-specific-selector)", color: C.fg,
        cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
        verticalAlign: "middle", boxSizing: "border-box",
      },
      btnOn: { background: "var(--dsw-alias-interactive-bg-hover-solid)", color: C.accent },
      wrap: {
        borderRadius: 16,
        // 层级：面板在 dock slot 里时，祖先 .wSkVaW_composerSeat 带
        // z-index:9 + will-change:transform（两者各自创建层叠上下文），
        // 面板内部的 z-index 只能在那个上下文里比较、整体照样被压住 ——
        // 提高 z-index 是无效改法。所以面板 portal 到 body 再 position:fixed，
        // 才真正参与根上下文的比较；30500 高于鲸鱼立绘（.dshwv-root 9999、
        // .dshwv-tplhelp 26080），又低于它的确认遮罩（32000!important），
        // 那些遮罩是临时弹窗，让它们盖住无妨。
        zIndex: 30500,
        border: "1px solid " + C.line,
        background: C.bg,
        boxShadow: "0 12px 36px rgba(0,0,0,.24)",
        font: "13px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif",
        color: C.fg,
        overflowY: "auto", overscrollBehavior: "contain",
        WebkitOverflowScrolling: "touch",
        boxSizing: "border-box",
      },
      hero: {
        padding: "12px 14px 11px",
        background: "linear-gradient(135deg, " + C.accent3 + ", transparent 70%)",
        borderBottom: "1px solid " + C.line4,
        borderTopLeftRadius: 15, borderTopRightRadius: 15,
        display: "flex", alignItems: "center", gap: 9,
      },
      badge: {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, borderRadius: 8,
        background: C.accent3, color: C.accent, flex: "none",
      },
      heroText: { display: "flex", flexDirection: "column", gap: 1, marginRight: "auto", minWidth: 0 },
      title: { fontWeight: 700, fontSize: 13.5, letterSpacing: ".2px" },
      sub: { fontSize: 10.5, color: C.fg3, letterSpacing: ".2px" },
      x: {
        width: 26, height: 26, borderRadius: 7, border: "none", cursor: "pointer",
        background: "transparent", color: C.fg3, fontSize: 17, lineHeight: 1, padding: 0, flex: "none",
      },
      body: { padding: "11px 14px 13px" },
      sec: { marginBottom: 11 },
      secHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 },
      secTitle: { fontSize: 11, fontWeight: 700, color: C.fg2, letterSpacing: ".4px" },
      secExtra: { fontSize: 10.5, color: C.fg3, marginLeft: "auto" },
      segs: {
        display: "flex", gap: 4, padding: 3, borderRadius: 11,
        background: C.bg2, border: "1px solid " + C.line4,
      },
      seg: {
        flex: 1, height: 30, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent", color: C.fg3, font: "12px system-ui", fontWeight: 600,
        lineHeight: 1, boxSizing: "border-box", whiteSpace: "nowrap",
      },
      segOn: { background: C.bg, color: C.fg, boxShadow: "0 1px 5px rgba(0,0,0,.16)" },
      desc: { fontSize: 11, color: C.fg3, lineHeight: 1.55, marginTop: 6, padding: "0 2px" },
      pick: {
        width: "100%", maxWidth: "100%", boxSizing: "border-box",
        padding: "8px 10px", borderRadius: 10, cursor: "pointer",
        border: "1px solid " + C.line, background: C.bg2, color: C.fg,
        font: "inherit", textAlign: "left",
        display: "flex", alignItems: "center", gap: 6, minHeight: 38,
      },
      pickName: { fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      pickMeta: { fontSize: 10.5, color: C.fg3, marginLeft: "auto", flex: "none" },
      list: {
        marginTop: 6, borderRadius: 11, border: "1px solid " + C.line,
        background: C.bg, maxHeight: 260, overflowY: "auto",
      },
      search: {
        margin: "6px 8px", boxSizing: "border-box", width: "calc(100% - 16px)",
        padding: "6px 9px", borderRadius: 8, border: "1px solid " + C.line3,
        background: C.bg2, color: C.fg, font: "12px inherit", outline: "none",
      },
      groupHead: {
        padding: "7px 10px 4px", fontSize: 10, fontWeight: 700, color: C.fg3,
        letterSpacing: ".5px", textTransform: "uppercase",
      },
      item: {
        display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
        border: "none", background: "transparent", color: C.fg, cursor: "pointer",
        font: "inherit", borderTop: "1px solid " + C.line4,
      },
      itemOn: { background: C.accent3, color: C.fg },
      itemName: { fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 },
      itemSub: { fontSize: 10.5, color: C.fg3, marginTop: 1, lineHeight: 1.45 },
      tag: {
        fontSize: 9.5, padding: "1px 5px", borderRadius: 5, flex: "none",
        border: "1px solid " + C.line3, color: C.fg3,
      },
      ta: {
        width: "100%", boxSizing: "border-box", minHeight: 66, maxHeight: 180,
        resize: "vertical", padding: "9px 10px", borderRadius: 10,
        font: "13px/1.6 inherit", border: "1px solid " + C.line,
        background: C.bg2, color: C.fg, outline: "none",
      },
      chips: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 },
      chip: {
        padding: "4px 10px", borderRadius: 999, cursor: "pointer",
        border: "1px solid " + C.line3, background: "transparent",
        color: C.fg3, font: "11px system-ui", lineHeight: 1.5,
      },
      row: { display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap", alignItems: "center" },
      primary: {
        padding: "9px 20px", borderRadius: 10, border: "none", cursor: "pointer",
        background: C.accent, color: "#fff", font: "12.5px system-ui", fontWeight: 700,
        display: "inline-flex", alignItems: "center", gap: 6,
        boxShadow: "0 2px 10px rgba(0,0,0,.16)",
      },
      ghost: {
        padding: "8px 13px", borderRadius: 10, cursor: "pointer",
        border: "1px solid " + C.line, background: "transparent",
        color: C.fg, font: "12px system-ui",
        display: "inline-flex", alignItems: "center", gap: 5,
      },
      out: {
        marginTop: 2, padding: 11, borderRadius: 11, whiteSpace: "pre-wrap",
        background: C.bg2, border: "1px solid " + C.line3,
        maxHeight: 260, overflow: "auto", userSelect: "text", color: C.fg,
        font: "12.5px/1.65 inherit",
      },
      toggle: {
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 10px", borderRadius: 10, background: C.bg2,
        border: "1px solid " + C.line4, cursor: "pointer", fontSize: 12, color: C.fg,
      },
      foot: {
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 11, paddingTop: 9, borderTop: "1px solid " + C.line4,
        fontSize: 10.5, color: C.fg3, flexWrap: "wrap",
      },
      dot: { width: 5, height: 5, borderRadius: "50%", background: C.accent, flex: "none" },
      err: { color: C.danger, fontSize: 12, marginTop: 9 },
      note: { color: C.fg2, fontSize: 12, marginTop: 9 },
      warn: { color: C.fg2, fontSize: 11, marginTop: 6 },
      spin: {
        width: 12, height: 12, borderRadius: "50%", flex: "none",
        border: "2px solid rgba(255,255,255,.35)", borderTopColor: "#fff",
        animation: "dpo-spin .7s linear infinite",
      },
      skel: { height: 11, marginBottom: 7 },
      meta: { fontSize: 10.5, color: C.fg3, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" },
      debugBox: {
        marginTop: 8, padding: 10, borderRadius: 10, background: C.bg2,
        border: "1px solid " + C.line4,
        font: "11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace",
        whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", color: C.fg2,
      },
      debugHead: { fontSize: 10.5, fontWeight: 700, color: C.fg3, marginTop: 8 },
    };

    const MODES = [
      ["user", "普通提示词"],
      ["system", "系统提示词 / 人设"],
      ["iterate", "在现有稿上改"],
    ];
    const MODE_DESC = {
      user: "要 AI 做什么。改写后补角色、任务、上下文、输出格式、约束，能直接发给 AI。",
      system: "AI 是谁。改写后把「温柔一点」这类模糊描述换成能判断对错的行为准则。",
      iterate: "按你的要求改现有稿子，只动你要求的部分，其余保持原样。",
    };
    const QUICK = {
      user: ["更具体", "加输出格式", "加约束条件", "面向新手"],
      system: ["更严格", "加行为准则", "加反例", "更简短"],
      iterate: ["再短一点", "加例子", "语气更强硬", "去掉客套"],
    };

    // ── 小图标 ──────────────────────────────────────────────────────────────
    // ⚠️ 这里是 jsx(type, props, key)：第三个参数会被当成 React 的 key，
    //    不是 children。之前把 path 元素放在第三位，结果 svg 里永远没有内容。
    function Icon(props) {
      return jsx("svg", {
        width: props.size || 12, height: props.size || 12, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 2.1,
        strokeLinecap: "round", strokeLinejoin: "round",
        style: { flex: "none" },
        children: jsx("path", { d: props.d }),
      });
    }
    const ICON = {
      spark: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
      mode: "M4 7h16M4 12h10M4 17h13",
      cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 6h12v12H6z",
      text: "M4 6h16M4 12h12M4 18h8",
      ctx: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18",
      down: "M6 9l6 6 6-6",
    };

    function Section(props) {
      return jsxs("div", {
        style: S.sec,
        children: [
          jsxs("div", {
            style: S.secHead,
            children: [
              jsx("span", {
                style: { color: C.fg3, display: "inline-flex" },
                children: jsx(Icon, { d: props.icon, size: 12 }),
              }),
              jsx("span", { style: S.secTitle, children: props.title }),
              props.extra ? jsx("span", { style: S.secExtra, children: props.extra }) : null,
            ],
          }),
          props.children,
        ],
      });
    }

    // ── 按钮（输入栏左侧）──────────────────────────────────────────────────
    function OptimizeButton() {
      const s = useStore();
      return jsxs("button", {
        type: "button",
        className: "dpo-btn",
        title: "优化提示词（先把话打在输入框里）",
        "aria-label": "优化提示词",
        "aria-pressed": s.open ? "true" : "false",
        style: s.open ? { ...S.btn, ...S.btnOn } : S.btn,
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          if (s.open) { store.set({ open: false }); return; }
          // 不再清空 out/err：关掉面板再打开时，上一次的结果还应该在。
          const live = readDraft();
          const patch = { open: true };
          if (!store.src && live) patch.src = live;
          store.set(patch);
          loadProviders();
        },
        children: [
          jsx(Icon, { d: ICON.spark, size: 17 }),
        ],
      });
    }

    // ── 模型选择：收起一行，展开是带搜索的分组列表 ──────────────────────────
    function ModelPicker({ s }) {
      const group = (s.providers || []).find((p) => p.id === s.prov);
      const model = group && group.models.find((m) => m.id === s.model);
      const query = s.pickQuery.trim().toLowerCase();
      const groups = (s.providers || []).map((p) => ({
        ...p,
        models: p.models.filter((m) => !query
          || String(m.name || m.id).toLowerCase().includes(query)
          || String(m.id).toLowerCase().includes(query)
          || String(p.name || p.id).toLowerCase().includes(query)
          || String(m.description || "").toLowerCase().includes(query)),
      })).filter((p) => p.models.length);

      const disabled = s.busy || s.modelsLoading || !!s.modelsError || !s.providers?.length;

      return jsxs("div", { children: [
        jsxs("button", {
          type: "button", className: "dpo-btn",
          style: { ...S.pick, opacity: disabled ? 0.6 : 1 },
          disabled,
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => store.set({ pickerOpen: !s.pickerOpen }),
          "aria-expanded": s.pickerOpen ? "true" : "false",
          children: [
            jsx("span", {
              style: S.pickName,
              children: s.modelsLoading ? "正在加载模型…" : model ? (model.name || model.id) : "请选择模型",
            }),
            jsx("span", {
              style: S.pickMeta,
              children: model ? (group.name || group.id) : (s.providers ? s.providers.length + " 个提供方" : ""),
            }),
            jsx(Icon, { d: ICON.down, size: 11 }),
          ],
        }),

        s.pickerOpen && !disabled ? jsxs("div", {
          className: "dpo-list", style: S.list,
          children: [
            jsx("input", {
              style: S.search,
              value: s.pickQuery,
              placeholder: "搜索模型或提供方",
              onChange: (e) => store.set({ pickQuery: e.target.value }),
              onMouseDown: (e) => e.stopPropagation(),
            }),
            ...groups.map((p) => jsxs("div", { children: [
              jsx("div", { style: S.groupHead, children: p.name || p.id }),
              ...p.models.map((m) => jsxs("button", {
                type: "button",
                className: "dpo-item",
                style: s.prov === p.id && s.model === m.id ? { ...S.item, ...S.itemOn } : S.item,
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => store.set({
                  prov: p.id, model: m.id, modelSelected: true,
                  pickerOpen: false, pickQuery: "", err: "",
                }),
                children: [
                  jsxs("span", {
                    style: S.itemName,
                    children: [
                      jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: m.name || m.id }),
                      m.reasoning && m.reasoning.efforts > 1 ? jsx("span", { style: S.tag, children: "可调思考" }) : null,
                    ],
                  }),
                  jsx("span", {
                    style: S.itemSub,
                    children: [m.description || m.id, p.name || p.id].filter(Boolean).join(" · "),
                  }),
                ],
              }, p.id + "\u0000" + m.id)),
            ] }, p.id)),
            groups.length ? null : jsx("div", { style: { ...S.itemSub, padding: "10px" }, children: "没有匹配的模型。" }),
          ],
        }) : null,

        s.modelsError || s.modelsNotice || (s.failedProviders || []).length ? jsxs("div", { role: "status", children: [
          s.modelsError ? jsx("div", { style: S.err, children: s.modelsError }) : null,
          s.modelsNotice ? jsx("div", { style: S.warn, children: s.modelsNotice }) : null,
          ...(s.failedProviders || []).map((f) => jsx("div", {
            style: S.warn,
            children: (f.name || f.id) + "：" + (f.message || "目录加载失败"),
          }, f.id || f.name)),
          // 只有真的没拿到模型、或有提供方加载失败时才给这个按钮。
          // 「已隐藏 2 个非文本模型」是正常信息，旁边挂个重新加载只会让人以为出了问题。
          s.modelsError || (s.failedProviders || []).length
            ? jsx("button", { type: "button", style: S.ghost, onClick: loadProviders, children: "重新加载模型" })
            : null,
        ] }) : null,
      ] });
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    // 长上下文会先做一次摘要再改写，耗时明显更长；按钮上要说清楚在等什么，
    // 否则用户会以为卡死。摘要阈值与后端 SUMMARY_THRESHOLD 保持一致，
    // 这里只能按上下文长度预判，无法知道摘要是否命中缓存，所以措辞用「可能」。
    const SUMMARY_HINT = 12000;

    function busyLabel(s) {
      const secs = (s.elapsed / 1000).toFixed(1) + "s";
      if (s.ctxLen > SUMMARY_HINT) return "上下文较长，可能要先压缩… " + secs;
      return "优化中… " + secs;
    }

    // ── 面板定位：贴在输入框上方 ────────────────────────────────────────────
    // 面板 portal 到 body 后是 position:fixed，就得自己算位置。
    // 锚点用宿主的 composer 卡片（data-composer-card），它跟着输入框一起动。
    function panelAnchor() {
      const vw = window.innerWidth || 375;
      // fixed 元素的 bottom 是相对布局视口量的，所以这里用 innerHeight；
      // 但「屏幕上真正看得见的高度」是 visualViewport（键盘弹出时它才变），
      // maxHeight 必须按可见区域算，否则面板会伸到键盘底下去。
      const layoutVH = window.innerHeight || 800;
      const vv = window.visualViewport;
      const visTop = vv ? vv.offsetTop : 0;
      const visBottom = vv ? vv.offsetTop + vv.height : layoutVH;
      const el = document.querySelector("[data-composer-card]")
        || document.querySelector("[data-composer-dock]");
      const rect = el ? el.getBoundingClientRect() : null;
      const width = Math.min(560, vw - 16);
      const left = Math.max(8, Math.round((vw - width) / 2));
      // 面板底边贴着输入框顶边；取不到卡片就退成「占可见高度的 72%」。
      const bottom = rect && rect.top > 0
        ? Math.max(48, Math.round(layoutVH - rect.top + 8))
        : Math.max(48, Math.round(visBottom - (visBottom - visTop) * 0.72));
      const top = rect ? rect.top : visTop + (visBottom - visTop) * 0.28;
      const avail = Math.round(top - visTop - 12);
      return { left, width, bottom, maxHeight: Math.max(240, avail) };
    }

    function OptimizePanel({ session }) {
      const sessionId = session?.sessionId;
      const s = useStore();
      const restored = useRef(false);

      // 刷新页面后按会话恢复上一次结果（sessionStorage 允许，见 7.2 第 5 项）
      useEffect(() => {
        if (restored.current || !s.open || !sessionId) return;
        restored.current = true;
        if (s.out) return;
        const last = readLast();
        if (!last || last.sessionId !== sessionId) return;
        store.set({
          out: last.out, meta: last.meta || null,
          src: s.src || last.src || "", req: s.req || last.req || "",
          mode: last.mode || s.mode,
        });
      }, [s.open, sessionId]);

      // Esc 关闭面板 / Esc 取消正在跑的请求
      useEffect(() => {
        if (!s.open) return;
        const onKey = (e) => {
          if (e.key !== "Escape") return;
          if (store.busy) { cancel(); return; }
          store.set({ open: false });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [s.open, s.busy]);

      // 面板 portal 出去之后是 fixed 定位，视口/输入框位置变了就得重算。
      // 必须放在 `if (!s.open) return null` 之前：hooks 数量不能随 open 变化。
      const [, bumpView] = useState(0);
      useEffect(() => {
        if (!s.open || !createPortal) return undefined;
        const bump = () => bumpView((n) => n + 1);
        window.addEventListener("resize", bump);
        window.addEventListener("orientationchange", bump);
        // 手机上键盘弹出会缩掉可视区域，但部分浏览器 window.innerHeight 不变，
        // 只有 visualViewport 会动 —— 不听这个，面板就会算到键盘底下去。
        const vv = window.visualViewport;
        if (vv) {
          vv.addEventListener("resize", bump);
          vv.addEventListener("scroll", bump);
        }
        // 键盘弹出、输入框长高都会改变卡片位置，能观察就一起观察。
        let ro = null;
        const el = document.querySelector("[data-composer-card]");
        if (typeof ResizeObserver === "function" && el) {
          ro = new ResizeObserver(bump);
          ro.observe(el);
        }
        return () => {
          window.removeEventListener("resize", bump);
          window.removeEventListener("orientationchange", bump);
          if (vv) {
            vv.removeEventListener("resize", bump);
            vv.removeEventListener("scroll", bump);
          }
          if (ro) ro.disconnect();
        };
      }, [s.open]);

      if (!s.open) return null;
      const ctxOn = !!sessionId && s.contextSession === sessionId;

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(s.out);
          store.set({ err: "", note: "已复制到剪贴板。" });
        } catch {
          store.set({ err: "复制失败（浏览器不给剪贴板权限）" });
        }
      };

      // 先把面板关掉（让它卸载），再在下一帧写输入框。
      // 面板还挂在上面时写，Lexical 和 React 会同时动 DOM —— 那才是「卡」的来源。
      const fill = () => {
        const text = s.out;
        store.set({ open: false });
        requestAnimationFrame(() => {
          const r = writeDraft(text);
          if (!r.ok) {
            // 失败也别把结果弄丢：out 保留，用户还能点复制。
            store.set({ open: true, err: "没写进输入框（" + r.how + "）。可以点「复制」手动粘贴。" });
            return;
          }
          // 成功也留一句话：下次打开面板能确认「已经填进去了、可以改了」。
          store.set({ note: "已填入输入框，可以直接编辑或发送。" });
        });
      };

      const refine = () =>
        store.set({ mode: "iterate", src: s.out, req: "", err: "", note: "" });
      const retry = () => store.set({ out: "", meta: null, debug: null, err: "", note: "" });
      const addQuick = (q) => {
        const cur = s.req.trim();
        store.set({ req: cur ? cur + "；" + q : q });
      };

      const modelLabel = (() => {
        const group = (s.providers || []).find((p) => p.id === s.prov);
        const model = group && group.models.find((m) => m.id === s.model);
        return model ? ((model.name || model.id) + " · " + (group.name || group.id)) : "";
      })();

      const meta = s.meta;
      const metaBits = [];
      if (meta) {
        if (meta.elapsedMs) metaBits.push((meta.elapsedMs / 1000).toFixed(1) + " 秒");
        if (meta.usage && meta.usage.outputTokens) {
          metaBits.push("输出 " + meta.usage.outputTokens + " tok"
            + (meta.usage.reasoningTokens ? "（含思考 " + meta.usage.reasoningTokens + "）" : ""));
        }
        // usage.reasoningTokens 在多数提供方上恒为 null（实测 6 个提供方全 null），
        // 所以思考量按后端实际收到的 reasoning 字符数报，不依赖 token 统计。
        if (meta.reasoningChars) metaBits.push("思考 " + meta.reasoningChars + " 字");
        if (meta.finish === "max-tokens") metaBits.push("输出被长度上限截断，建议再点「继续改」补齐");
        if (meta.ttftMs) metaBits.push("首字 " + (meta.ttftMs / 1000).toFixed(1) + " 秒");
        if (meta.summary) {
          // 摘要是一次额外调用，用户有权知道多花了多久、省了多少字。
          // 少于 0.5 秒说明命中了服务端缓存，直接说复用，别报「0.0 秒」。
          const reuse = meta.summary.elapsedMs < 500;
          metaBits.push("上下文 " + meta.contextChars + " 字已摘要为 " + meta.summary.chars + " 字"
            + (reuse ? "（复用上次摘要）" : "（摘要耗时 " + (meta.summary.elapsedMs / 1000).toFixed(1) + " 秒）"));
        } else if (meta.summaryFailed) {
          metaBits.push("上下文 " + meta.contextChars + " 字（压缩失败，已按原文发送）");
        } else if (meta.contextChars) {
          metaBits.push("上下文 " + meta.contextChars + " 字");
        }
      }

      const anchor = createPortal ? panelAnchor() : null;
      const panel = jsxs("div", {
        className: "dpo-panel",
        style: anchor
          ? { ...S.wrap, position: "fixed", left: anchor.left, width: anchor.width,
              bottom: anchor.bottom, maxHeight: anchor.maxHeight }
          : { ...S.wrap, margin: "0 0 8px 0", maxHeight: "calc(100vh - 200px)" },
        children: [
          jsxs("div", {
            style: S.hero,
            children: [
              jsx("span", { style: S.badge, children: jsx(Icon, { d: ICON.spark, size: 14 }) }),
              jsxs("div", {
                style: S.heroText,
                children: [
                  jsx("span", { style: S.title, children: "提示词优化" }),
                  jsx("span", {
                    style: S.sub,
                    children: (MODES.find((m) => m[0] === s.mode) || ["", ""])[1]
                      + (ctxOn ? " · 结合上下文" : ""),
                  }),
                ],
              }),
              jsx("button", {
                type: "button", style: S.x, title: "关闭（Esc）",
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => store.set({ open: false }), children: "×",
              }),
            ],
          }),

          jsxs("div", {
            style: S.body,
            children: [
              // 内容在前：这是整件事的主体，主操作紧跟在它下面，第一屏可见。
              jsx(Section, {
                icon: ICON.text, title: "要优化的内容",
                extra: (s.src ? s.src.length + " 字" : "留空则用输入框里的文字"),
                children: jsx("textarea", {
                  style: S.ta,
                  value: s.src,
                  placeholder: "把要改写的话粘贴进来，或直接在下面输入框里写，然后点开始优化",
                  onChange: (e) => store.set({ src: e.target.value }),
                }),
              }),

              jsxs("div", {
                style: { ...S.row, marginTop: 0 },
                children: [
                  jsxs("button", {
                    type: "button", className: "dpo-btn",
                    style: { ...S.primary, opacity: s.busy ? 0.7 : 1 },
                    disabled: s.busy || s.modelsLoading || !!s.modelsError || !s.model,
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: () => optimize(sessionId),
                    children: [
                      s.busy ? jsx("span", { style: S.spin }) : jsx(Icon, { d: ICON.spark, size: 12 }),
                      jsx("span", { children: s.busy ? busyLabel(s) : "开始优化" }),
                    ],
                  }),
                  s.busy ? jsx("button", {
                    type: "button", className: "dpo-btn", style: S.ghost,
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: cancel, children: "取消",
                  }) : null,
                  jsx("button", {
                    type: "button", className: "dpo-btn", style: S.ghost,
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: () => store.set({ src: readDraft(), err: "", note: "" }),
                    children: "读输入框",
                  }),
                ],
              }),

              s.err ? jsx("div", { style: S.err, children: s.err }) : null,
              s.note ? jsx("div", { style: S.note, children: s.note }) : null,

              s.busy ? jsxs("div", {
                style: { marginTop: 12 },
                children: [
                  jsx("div", { style: { ...S.secTitle, marginBottom: 6 }, children: "优化结果" }),
                  jsxs("div", {
                    style: { ...S.out, minHeight: 54 },
                    children: [
                      jsx("div", { className: "dpo-skel", style: { ...S.skel, width: "88%" } }),
                      jsx("div", { className: "dpo-skel", style: { ...S.skel, width: "72%" } }),
                      jsx("div", { className: "dpo-skel", style: { ...S.skel, width: "54%", marginBottom: 0 } }),
                    ],
                  }),
                ],
              }) : null,

              s.out && !s.busy ? jsxs("div", {
                style: { marginTop: 12 },
                children: [
                  jsx("div", {
                    style: { ...S.secTitle, marginBottom: 6 },
                    children: "优化结果 · " + s.out.length + " 字"
                      + (s.stale ? "（上一次的结果，本次没有成功）" : ""),
                  }),
                  jsx("div", { className: "dpo-out", style: S.out, children: s.out }),
                  metaBits.length ? jsx("div", { style: S.meta, children: metaBits.map((b) => jsx("span", { children: b }, b)) }) : null,
                  jsxs("div", {
                    style: S.row,
                    children: [
                      jsx("button", {
                        type: "button", className: "dpo-btn", style: S.primary,
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: fill, children: "填入输入框",
                      }),
                      jsx("button", {
                        type: "button", className: "dpo-btn", style: S.ghost,
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: copy, children: "复制",
                      }),
                      jsx("button", {
                        type: "button", className: "dpo-btn", style: S.ghost,
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: refine, children: "继续改",
                      }),
                      jsx("button", {
                        type: "button", className: "dpo-btn", style: S.ghost,
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: retry, children: "重来",
                      }),
                    ],
                  }),
                  jsxs("div", {
                    style: S.row,
                    children: [
                      jsx("button", {
                        type: "button", className: "dpo-btn", style: { ...S.chip, padding: "4px 10px" },
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: () => store.set({ showDebug: !s.showDebug }),
                        children: (s.showDebug ? "▾ " : "▸ ") + "查看详情（发送内容与思考过程）",
                      }),
                    ],
                  }),
                  s.showDebug ? jsxs("div", {
                    children: [
                      s.debug ? jsxs("div", { children: [
                        jsx("div", { style: S.debugHead, children: "实际发给模型的内容" }),
                        jsxs("div", { style: S.debugBox, children: [
                          "--- system ---\n", s.debug.system || "",
                          "\n\n--- user ---\n", s.debug.input || "",
                        ] }),
                        jsx("div", { style: S.debugHead, children: "模型思考过程（" + (s.debug.reasoning || "").length + " 字）" }),
                        jsx("div", {
                          style: { ...S.debugBox, maxHeight: 180 },
                          children: s.debug.reasoning || "该模型没有返回思考过程。",
                        }),
                      ] }) : jsx("div", {
                        style: S.debugBox,
                        children: "这条结果没有附带详情（可能是刷新后从本地恢复的旧结果）。点「开始优化」重跑一次即可看到。",
                      }),
                    ],
                  }) : null,
                ],
              }) : null,

              jsx(Section, {
                icon: ICON.mode, title: "优化方式",
                children: jsxs("div", {
                  children: [
                    jsx("div", {
                      style: S.segs,
                      children: MODES.map((m) =>
                        jsx("button", {
                          type: "button", className: "dpo-btn",
                          style: s.mode === m[0] ? { ...S.seg, ...S.segOn } : S.seg,
                          onMouseDown: (e) => e.preventDefault(),
                          onClick: () => store.set({ mode: m[0], err: "", note: "" }),
                          children: m[1],
                        }, m[0])),
                    }),
                    jsx("div", { style: S.desc, children: MODE_DESC[s.mode] || "" }),
                  ],
                }),
              }),

              jsx(Section, {
                icon: ICON.mode, title: "补充要求（可选）",
                extra: "会作为额外要求发给模型",
                children: jsxs("div", {
                  children: [
                    jsx("textarea", {
                      style: { ...S.ta, minHeight: 44 },
                      value: s.req,
                      placeholder: "例如：输出要更短、要有具体步骤、去掉客套话",
                      onChange: (e) => store.set({ req: e.target.value }),
                    }),
                    jsx("div", {
                      style: S.chips,
                      children: QUICK[s.mode].map((q) =>
                        jsx("button", {
                          type: "button", className: "dpo-chip", style: S.chip,
                          onMouseDown: (e) => e.preventDefault(),
                          onClick: () => addQuick(q),
                          children: "+ " + q,
                        }, q)),
                    }),
                  ],
                }),
              }),

              jsx(Section, {
                icon: ICON.cpu, title: "模型",
                extra: s.providers ? s.providers.length + " 个提供方" : "加载中…",
                children: jsx(ModelPicker, { s }),
              }),

              jsx(Section, {
                icon: ICON.ctx, title: "对话上下文",
                children: jsxs("label", {
                  style: S.toggle,
                  children: [
                    jsx("input", {
                      type: "checkbox",
                      checked: ctxOn,
                      disabled: !sessionId || s.busy,
                      onChange: (e) => {
                        const on = e.target.checked;
                        const ctx = on ? readContext(sessionId) : "";
                        store.set({ contextSession: on ? sessionId : null, ctxLen: ctx.length });
                      },
                      style: { width: 15, height: 15, accentColor: C.accent, margin: 0, flex: "none" },
                    }),
                    jsx("span", { style: { marginRight: "auto" }, children: "附带当前会话的近期消息，仅作参考，不会当成要改写的内容" }),
                    jsx("span", {
                      style: { color: C.fg3, fontSize: 10.5, flex: "none" },
                      children: ctxOn ? (s.ctxLen ? s.ctxLen + " 字" : "未找到可用消息") : "未启用",
                    }),
                  ],
                }),
              }),

              jsxs("div", {
                style: S.foot,
                children: [
                  jsx("span", { className: "dpo-dot", style: S.dot }),
                  jsx("span", {
                    children: (modelLabel ? "模型 " + modelLabel : "未选择模型")
                      + (ctxOn && s.ctxLen ? " · 已读上下文 " + s.ctxLen + " 字" : ""),
                  }),
                ],
              }),
            ],
          }),
        ],
      });

      if (!createPortal) return panel;
      // portal 目标可能还没 ready（首次渲染早于 body），退回原地渲染。
      const host = typeof document !== "undefined" ? document.body : null;
      if (!host) return panel;
      return createPortal(panel, host);
    }

    // ── 注册 ───────────────────────────────────────────────────────────────
    function apply(ctx) {
      // 样式是插件自己的资源，交给 ctx.effect 持有：禁用/卸载插件时移除 <style>。
      // 没有 effect（老宿主或被测试直接调用）时退化成一次性注入。
      if (typeof ctx.effect === "function") {
        ctx.effect(() => ensureCSS(), "dsh-prompt-optimize-button: panel stylesheet");
      } else {
        ensureCSS();
      }
      // ⚠️ list 类型的 slot，register 必须带 id（键）和 order（排序），
      //    只给 name 会在加载时抛错，而抛错在手机上看不到 —— 表现就是「按钮根本没出现」。
      ctx.inject(["slots"], (scope) => {
        try {
          scope.slots.inject("conversation.input.left", () => scope.slots.register({
            name: "conversation.input.left",
            id: "prompt-optimize",
            order: 10,
          }, OptimizeButton));
        } catch (e) {
          console.warn("Prompt optimizer: failed to register left slot", e);
        }
        try {
          scope.slots.inject("conversation.input.dock", () => scope.slots.register({
            name: "conversation.input.dock",
            id: "prompt-optimize-panel",
            order: 10,
          }, OptimizePanel));
        } catch (e) {
          console.warn("Prompt optimizer: failed to register dock slot", e);
        }
      });
    }
    exports.apply = apply;

    // 给自检用（浏览器里没人读它）
    exports.__test = {
      store, OptimizeButton, OptimizePanel, ModelPicker, readDraft, writeDraft,
      loadProviders, readContext, ensureCSS, lexicalState, isNonText,
      optimize, cancel, readLast, saveLast, panelAnchor, apply,
    };
    return module.exports;
  },
});
