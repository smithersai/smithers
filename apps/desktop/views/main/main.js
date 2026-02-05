var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
// apps/desktop/src/webview/chat/ChatAgent.ts
class ChatAgent {
  _state;
  listeners = new Set;
  transport;
  abortController;
  constructor(opts) {
    this._state = {
      messages: [],
      isStreaming: false,
      streamingMessage: null,
      ...opts.initialState
    };
    this.transport = opts.transport;
  }
  get state() {
    return this._state;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this._state);
    return () => this.listeners.delete(fn);
  }
  appendMessage(message) {
    this.patch({ messages: [...this._state.messages, message] });
  }
  replaceMessages(messages) {
    this.patch({ messages: [...messages] });
  }
  clearMessages() {
    this.patch({ messages: [] });
  }
  abort() {
    this.abortController?.abort();
  }
  async send(text, attachments) {
    console.log("[ChatAgent] send() called with text:", text);
    const userMessage = {
      role: "user",
      content: text,
      attachments,
      timestamp: Date.now()
    };
    this.appendMessage(userMessage);
    console.log("[ChatAgent] User message appended, total messages:", this._state.messages.length);
    this.abortController = new AbortController;
    this.patch({ isStreaming: true, streamingMessage: null, error: undefined });
    try {
      for await (const event of this.transport.run(this._state.messages, userMessage, {}, this.abortController.signal)) {
        this.handleEvent(event);
        if (event.type === "agent_end")
          break;
      }
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.patch({ isStreaming: false, streamingMessage: null });
      this.abortController = undefined;
    }
  }
  handleEvent(event) {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.patch({ streamingMessage: event.message });
        break;
      case "message_end":
        if (event.message.role !== "user") {
          this.appendMessage(event.message);
        }
        this.patch({ streamingMessage: null });
        break;
    }
  }
  patch(partial) {
    this._state = { ...this._state, ...partial };
    for (const listener of this.listeners) {
      listener(this._state);
    }
  }
}
// apps/desktop/src/webview/chat/ChatPanel.ts
class ChatPanel extends HTMLElement {
  agent;
  unsubscribe;
  messages = [];
  streamingMessage = null;
  isStreaming = false;
  inputValue = "";
  inputAreaEl;
  messagesEl;
  textareaEl;
  sendBtnEl;
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }
  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }
  disconnectedCallback() {
    this.unsubscribe?.();
  }
  setAgent(agent) {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.agent = agent;
    this.unsubscribe = agent.subscribe((state) => {
      this.messages = state.messages;
      this.streamingMessage = state.streamingMessage;
      this.isStreaming = state.isStreaming;
      this.updateMessages();
      this.updateInputState();
    });
  }
  render() {
    if (!this.shadowRoot)
      return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
          font-family: system-ui, -apple-system, sans-serif;
          color: var(--text, #1b1a17);
          background: var(--bg, #faf6ee);
        }

        .messages {
          flex: 1;
          overflow-y: auto;
          padding: 0.75rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          background: var(--bg, #faf6ee);
        }

        .message {
          max-width: 80%;
          padding: 0.75rem 1rem;
          border-radius: 0;
          line-height: 1.5;
          font-size: 0.875rem;
          transition: opacity 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .message--user {
          align-self: flex-end;
          background: var(--text, #1b1a17);
          color: var(--bg, #faf6ee);
          border: 1px solid var(--border, #d4c9b5);
        }

        .message--assistant {
          align-self: flex-start;
          background: var(--panel, #f5efe3);
          color: var(--text, #1b1a17);
          border: 1px solid var(--border, #d4c9b5);
        }

        .message--toolResult {
          align-self: flex-start;
          background: var(--panel-2, #ece4d4);
          color: var(--muted, #6f675a);
          font-family: ui-monospace, monospace;
          font-size: 0.8125rem;
          border: 1px solid var(--border, #d4c9b5);
        }

        .message--workflow {
          align-self: flex-start;
          background: transparent;
          padding: 0;
        }

        .message--error {
          background: transparent;
          color: var(--danger, #b11226);
          border: 1px solid var(--danger, #b11226);
        }

        .message__thinking {
          color: var(--muted, #6f675a);
          font-style: italic;
          font-size: 0.8125rem;
          margin-bottom: 0.5rem;
        }

        .message__tool-call {
          background: var(--panel-2, #ece4d4);
          padding: 0.5rem;
          border-radius: 0;
          font-family: ui-monospace, monospace;
          font-size: 0.8125rem;
          margin-top: 0.5rem;
          border: 1px solid var(--border, #d4c9b5);
        }

        .messages:empty::after {
          content: "";
          flex: 1;
        }

        .input-area {
          padding: 0.75rem 1rem 1rem;
          background: var(--bg, #faf6ee);
          border-top: 1px solid var(--border, #d4c9b5);
        }

        .input-container {
          display: flex;
          align-items: flex-end;
          border: 1px solid var(--border, #d4c9b5);
          background: var(--panel, #f5efe3);
          transition: border-color 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .input-container:focus-within {
          border-color: var(--info, #2a4a9e);
        }

        .input-area textarea {
          flex: 1;
          padding: 0.75rem 0.875rem;
          border: none;
          font-size: 0.8125rem;
          line-height: 1.5;
          resize: none;
          min-height: 2.25rem;
          max-height: 8rem;
          font-family: inherit;
          background: transparent;
          color: var(--text, #1b1a17);
        }

        .input-area textarea::placeholder {
          color: var(--muted, #6f675a);
          opacity: 0.6;
        }

        .input-area textarea:focus {
          outline: none;
        }

        .input-area button {
          padding: 0.5rem 0.875rem;
          margin: 0.375rem;
          background: var(--text, #1b1a17);
          color: var(--bg, #faf6ee);
          border: none;
          font-size: 0.6875rem;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          font-weight: 600;
          font-family: inherit;
          transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
          flex-shrink: 0;
          align-self: flex-end;
        }

        .input-area button:hover:not(:disabled) {
          opacity: 0.8;
        }

        .input-area button:disabled {
          opacity: 0.25;
          cursor: default;
        }

        .input-area button:active:not(:disabled) {
          transform: translateY(1px);
        }

        .streaming-indicator {
          display: inline-block;
          width: 0.5rem;
          height: 0.5rem;
          background: #f27638;
          border-radius: 0;
          animation: champloo-breathe 1.6s ease-in-out infinite;
        }

        @keyframes champloo-breathe {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.08); opacity: 1; }
        }

        pre {
          background: var(--panel-2, #ece4d4);
          color: var(--text, #1b1a17);
          padding: 0.75rem;
          border-radius: 0;
          overflow-x: auto;
          font-size: 0.8125rem;
          border: 1px solid var(--border, #d4c9b5);
        }

        code {
          font-family: ui-monospace, monospace;
        }

        .workflow-card {
          border: 1px solid var(--border, #d4c9b5);
          border-radius: 0;
          padding: 0.75rem;
          background: var(--panel, #f5f5f5);
          color: var(--text, #111);
          transition: border-color 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .workflow-card__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .workflow-card__title {
          font-weight: 600;
          font-size: 0.875rem;
        }

        .workflow-card__meta {
          font-size: 0.75rem;
          color: var(--muted, #6f675a);
        }

        .workflow-card__status {
          font-size: 0.75rem;
          padding: 0.15rem 0.5rem;
          border-radius: 0;
          background: var(--panel-2, #ece4d4);
          color: var(--text, #1b1a17);
          border: 1px solid var(--border, #d4c9b5);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .workflow-card__actions {
          display: flex;
          gap: 0.5rem;
          margin-top: 0.5rem;
        }

        .workflow-card__actions button {
          background: var(--panel-2, #ece4d4);
          color: var(--text, #111);
          border: 1px solid var(--border, #d4c9b5);
          border-radius: 0;
          padding: 0.4rem 0.6rem;
          font-size: 0.75rem;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .workflow-card__actions button.primary {
          background: #f27638;
          color: #000;
          border-color: #f27638;
        }

        .workflow-card__actions button.danger {
          background: #b11226;
          color: #fff;
          border-color: #b11226;
        }

        .workflow-card__approval {
          margin-top: 0.5rem;
          padding: 0.5rem;
          border-radius: 0;
          background: var(--panel-2, #ece4d4);
          font-size: 0.75rem;
          border: 1px solid var(--border, #d4c9b5);
        }
      </style>

      <div class="messages"></div>

      <div class="input-area">
        <div class="input-container">
          <textarea placeholder="Message..." rows="1"></textarea>
          <button>Send</button>
        </div>
      </div>
    `;
    this.messagesEl = this.shadowRoot.querySelector(".messages");
    this.inputAreaEl = this.shadowRoot.querySelector(".input-area");
    this.textareaEl = this.shadowRoot.querySelector("textarea");
    this.sendBtnEl = this.shadowRoot.querySelector("button");
  }
  setupEventListeners() {
    this.textareaEl.addEventListener("input", (e) => {
      const textarea = e.target;
      this.inputValue = textarea.value;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      this.updateInputState();
    });
    this.textareaEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.sendBtnEl.addEventListener("click", () => {
      this.handleSend();
    });
    this.messagesEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!target)
        return;
      const button = target.closest("[data-workflow-action]");
      if (!button)
        return;
      const action = button.dataset.workflowAction;
      const runId = button.dataset.runId;
      if (!action || !runId)
        return;
      const nodeId = button.dataset.nodeId;
      const iteration = button.dataset.iteration ? Number(button.dataset.iteration) : undefined;
      this.dispatchEvent(new CustomEvent("workflow-card-action", {
        detail: { action, runId, nodeId, iteration },
        bubbles: true,
        composed: true
      }));
    });
  }
  handleSend() {
    const text = this.inputValue.trim();
    if (!text || this.isStreaming || !this.agent) {
      return;
    }
    this.inputValue = "";
    this.textareaEl.value = "";
    this.textareaEl.style.height = "auto";
    this.updateInputState();
    this.agent.send(text);
  }
  updateInputState() {
    this.textareaEl.disabled = this.isStreaming;
    this.sendBtnEl.disabled = !this.inputValue.trim() || this.isStreaming;
    this.sendBtnEl.textContent = this.isStreaming ? "Stop" : "Send";
    if (this.isStreaming) {
      this.sendBtnEl.onclick = () => this.agent?.abort();
    } else {
      this.sendBtnEl.onclick = () => this.handleSend();
    }
  }
  updateMessages() {
    const allMessages = this.streamingMessage ? [...this.messages, this.streamingMessage] : this.messages;
    this.messagesEl.innerHTML = allMessages.map((msg, idx) => {
      const isStreaming = msg === this.streamingMessage;
      const errorClass = msg.role === "assistant" && msg.stopReason === "error" ? " message--error" : "";
      return `
          <div class="message message--${msg.role}${errorClass}">
            ${this.renderMessageContent(msg)}
            ${isStreaming ? '<span class="streaming-indicator"></span>' : ""}
          </div>
        `;
    }).join("");
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    const hasAgent = Boolean(this.agent);
    if (this.inputAreaEl) {
      this.inputAreaEl.style.display = hasAgent ? "flex" : "none";
    }
    this.textareaEl.disabled = !hasAgent || this.isStreaming;
    this.sendBtnEl.disabled = !hasAgent || !this.inputValue.trim() || this.isStreaming;
  }
  renderMessageContent(message) {
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") {
        return `<div>${this.escapeHtml(content)}</div>`;
      }
      return content.map((c) => {
        if (c.type === "text")
          return `<div>${this.escapeHtml(c.text)}</div>`;
        if (c.type === "image")
          return `<img src="data:${c.mimeType};base64,${c.data}" style="max-width: 100%; border-radius: 0.375rem;" />`;
        return "";
      }).join("");
    }
    if (message.role === "assistant") {
      return message.content.map((c) => {
        if (c.type === "text")
          return `<div>${this.renderText(c.text)}</div>`;
        if (c.type === "thinking")
          return `<div class="message__thinking">${this.escapeHtml(c.thinking)}</div>`;
        if (c.type === "toolCall") {
          const tc = c;
          return `<div class="message__tool-call">→ ${this.escapeHtml(tc.name)}(${this.escapeHtml(JSON.stringify(tc.arguments))})</div>`;
        }
        return "";
      }).join("");
    }
    if (message.role === "toolResult") {
      const text = message.content.map((c) => c.type === "text" ? c.text : "").join(`
`);
      const truncated = text.slice(0, 200) + (text.length > 200 ? "..." : "");
      return `<div><strong>${this.escapeHtml(message.toolName)}:</strong> ${this.escapeHtml(truncated)}</div>`;
    }
    if (message.role === "workflow") {
      const card = message;
      const approvals = card.approvals ?? [];
      const approvalRows = approvals.map((approval) => `
          <div class="workflow-card__approval">
            Approval needed: ${this.escapeHtml(approval.nodeId)}
            <div class="workflow-card__actions">
              <button class="primary" data-workflow-action="approve" data-run-id="${this.escapeHtml(card.runId)}" data-node-id="${this.escapeHtml(approval.nodeId)}" data-iteration="${approval.iteration ?? 0}">Approve</button>
              <button class="danger" data-workflow-action="deny" data-run-id="${this.escapeHtml(card.runId)}" data-node-id="${this.escapeHtml(approval.nodeId)}" data-iteration="${approval.iteration ?? 0}">Deny</button>
            </div>
          </div>
        `).join("");
      return `
        <div class="workflow-card">
          <div class="workflow-card__header">
            <div>
              <div class="workflow-card__title">${this.escapeHtml(card.workflowName)}</div>
              <div class="workflow-card__meta">Run ${this.escapeHtml(card.runId.slice(0, 8))}</div>
            </div>
            <div class="workflow-card__status">${this.escapeHtml(card.status)}</div>
          </div>
          <div class="workflow-card__actions">
            <button data-workflow-action="focus" data-run-id="${this.escapeHtml(card.runId)}">Open run</button>
          </div>
          ${approvalRows}
        </div>
      `;
    }
    return "";
  }
  renderText(text) {
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    let result = "";
    let lastIndex = 0;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result += `<span>${this.escapeHtml(text.slice(lastIndex, match.index))}</span>`;
      }
      result += `<pre><code>${this.escapeHtml(match[2])}</code></pre>`;
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result += `<span>${this.escapeHtml(text.slice(lastIndex))}</span>`;
    }
    return result || this.escapeHtml(text);
  }
  escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
}
customElements.define("chat-panel", ChatPanel);
// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/guard/value.mjs
var exports_value = {};
__export(exports_value, {
  IsUndefined: () => IsUndefined,
  IsUint8Array: () => IsUint8Array,
  IsSymbol: () => IsSymbol,
  IsString: () => IsString,
  IsRegExp: () => IsRegExp,
  IsObject: () => IsObject,
  IsNumber: () => IsNumber,
  IsNull: () => IsNull,
  IsIterator: () => IsIterator,
  IsFunction: () => IsFunction,
  IsDate: () => IsDate,
  IsBoolean: () => IsBoolean,
  IsBigInt: () => IsBigInt,
  IsAsyncIterator: () => IsAsyncIterator,
  IsArray: () => IsArray,
  HasPropertyKey: () => HasPropertyKey
});
function HasPropertyKey(value, key) {
  return key in value;
}
function IsAsyncIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.asyncIterator in value;
}
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return typeof value === "bigint";
}
function IsBoolean(value) {
  return typeof value === "boolean";
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsFunction(value) {
  return typeof value === "function";
}
function IsIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.iterator in value;
}
function IsNull(value) {
  return value === null;
}
function IsNumber(value) {
  return typeof value === "number";
}
function IsObject(value) {
  return typeof value === "object" && value !== null;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsString(value) {
  return typeof value === "string";
}
function IsSymbol(value) {
  return typeof value === "symbol";
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUndefined(value) {
  return value === undefined;
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/clone/value.mjs
function ArrayType(value) {
  return value.map((value2) => Visit(value2));
}
function DateType(value) {
  return new Date(value.getTime());
}
function Uint8ArrayType(value) {
  return new Uint8Array(value);
}
function RegExpType(value) {
  return new RegExp(value.source, value.flags);
}
function ObjectType(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Visit(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Visit(value[key]);
  }
  return result;
}
function Visit(value) {
  return IsArray(value) ? ArrayType(value) : IsDate(value) ? DateType(value) : IsUint8Array(value) ? Uint8ArrayType(value) : IsRegExp(value) ? RegExpType(value) : IsObject(value) ? ObjectType(value) : value;
}
function Clone(value) {
  return Visit(value);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/clone/type.mjs
function CloneType(schema, options) {
  return options === undefined ? Clone(schema) : Clone({ ...options, ...schema });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs
function IsObject2(value) {
  return value !== null && typeof value === "object";
}
function IsArray2(value) {
  return globalThis.Array.isArray(value) && !globalThis.ArrayBuffer.isView(value);
}
function IsUndefined2(value) {
  return value === undefined;
}
function IsNumber2(value) {
  return typeof value === "number";
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/system/policy.mjs
var TypeSystemPolicy;
(function(TypeSystemPolicy2) {
  TypeSystemPolicy2.InstanceMode = "default";
  TypeSystemPolicy2.ExactOptionalPropertyTypes = false;
  TypeSystemPolicy2.AllowArrayObject = false;
  TypeSystemPolicy2.AllowNaN = false;
  TypeSystemPolicy2.AllowNullVoid = false;
  function IsExactOptionalProperty(value, key) {
    return TypeSystemPolicy2.ExactOptionalPropertyTypes ? key in value : value[key] !== undefined;
  }
  TypeSystemPolicy2.IsExactOptionalProperty = IsExactOptionalProperty;
  function IsObjectLike(value) {
    const isObject = IsObject2(value);
    return TypeSystemPolicy2.AllowArrayObject ? isObject : isObject && !IsArray2(value);
  }
  TypeSystemPolicy2.IsObjectLike = IsObjectLike;
  function IsRecordLike(value) {
    return IsObjectLike(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
  }
  TypeSystemPolicy2.IsRecordLike = IsRecordLike;
  function IsNumberLike(value) {
    return TypeSystemPolicy2.AllowNaN ? IsNumber2(value) : Number.isFinite(value);
  }
  TypeSystemPolicy2.IsNumberLike = IsNumberLike;
  function IsVoidLike(value) {
    const isUndefined = IsUndefined2(value);
    return TypeSystemPolicy2.AllowNullVoid ? isUndefined || value === null : isUndefined;
  }
  TypeSystemPolicy2.IsVoidLike = IsVoidLike;
})(TypeSystemPolicy || (TypeSystemPolicy = {}));

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/create/immutable.mjs
function ImmutableArray(value) {
  return globalThis.Object.freeze(value).map((value2) => Immutable(value2));
}
function ImmutableDate(value) {
  return value;
}
function ImmutableUint8Array(value) {
  return value;
}
function ImmutableRegExp(value) {
  return value;
}
function ImmutableObject(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Immutable(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Immutable(value[key]);
  }
  return globalThis.Object.freeze(result);
}
function Immutable(value) {
  return IsArray(value) ? ImmutableArray(value) : IsDate(value) ? ImmutableDate(value) : IsUint8Array(value) ? ImmutableUint8Array(value) : IsRegExp(value) ? ImmutableRegExp(value) : IsObject(value) ? ImmutableObject(value) : value;
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/create/type.mjs
function CreateType(schema, options) {
  const result = options !== undefined ? { ...options, ...schema } : schema;
  switch (TypeSystemPolicy.InstanceMode) {
    case "freeze":
      return Immutable(result);
    case "clone":
      return Clone(result);
    default:
      return result;
  }
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/error/error.mjs
class TypeBoxError extends Error {
  constructor(message) {
    super(message);
  }
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/symbols/symbols.mjs
var TransformKind = Symbol.for("TypeBox.Transform");
var ReadonlyKind = Symbol.for("TypeBox.Readonly");
var OptionalKind = Symbol.for("TypeBox.Optional");
var Hint = Symbol.for("TypeBox.Hint");
var Kind = Symbol.for("TypeBox.Kind");

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/guard/kind.mjs
function IsReadonly(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny(value) {
  return IsKindOf(value, "Any");
}
function IsArgument(value) {
  return IsKindOf(value, "Argument");
}
function IsArray3(value) {
  return IsKindOf(value, "Array");
}
function IsAsyncIterator2(value) {
  return IsKindOf(value, "AsyncIterator");
}
function IsBigInt2(value) {
  return IsKindOf(value, "BigInt");
}
function IsBoolean2(value) {
  return IsKindOf(value, "Boolean");
}
function IsComputed(value) {
  return IsKindOf(value, "Computed");
}
function IsConstructor(value) {
  return IsKindOf(value, "Constructor");
}
function IsDate2(value) {
  return IsKindOf(value, "Date");
}
function IsFunction2(value) {
  return IsKindOf(value, "Function");
}
function IsInteger(value) {
  return IsKindOf(value, "Integer");
}
function IsIntersect(value) {
  return IsKindOf(value, "Intersect");
}
function IsIterator2(value) {
  return IsKindOf(value, "Iterator");
}
function IsKindOf(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralValue(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsLiteral(value) {
  return IsKindOf(value, "Literal");
}
function IsMappedKey(value) {
  return IsKindOf(value, "MappedKey");
}
function IsMappedResult(value) {
  return IsKindOf(value, "MappedResult");
}
function IsNever(value) {
  return IsKindOf(value, "Never");
}
function IsNot(value) {
  return IsKindOf(value, "Not");
}
function IsNull2(value) {
  return IsKindOf(value, "Null");
}
function IsNumber3(value) {
  return IsKindOf(value, "Number");
}
function IsObject3(value) {
  return IsKindOf(value, "Object");
}
function IsPromise(value) {
  return IsKindOf(value, "Promise");
}
function IsRecord(value) {
  return IsKindOf(value, "Record");
}
function IsRef(value) {
  return IsKindOf(value, "Ref");
}
function IsRegExp2(value) {
  return IsKindOf(value, "RegExp");
}
function IsString2(value) {
  return IsKindOf(value, "String");
}
function IsSymbol2(value) {
  return IsKindOf(value, "Symbol");
}
function IsTemplateLiteral(value) {
  return IsKindOf(value, "TemplateLiteral");
}
function IsThis(value) {
  return IsKindOf(value, "This");
}
function IsTransform(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple(value) {
  return IsKindOf(value, "Tuple");
}
function IsUndefined3(value) {
  return IsKindOf(value, "Undefined");
}
function IsUnion(value) {
  return IsKindOf(value, "Union");
}
function IsUint8Array2(value) {
  return IsKindOf(value, "Uint8Array");
}
function IsUnknown(value) {
  return IsKindOf(value, "Unknown");
}
function IsUnsafe(value) {
  return IsKindOf(value, "Unsafe");
}
function IsVoid(value) {
  return IsKindOf(value, "Void");
}
function IsKind(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]);
}
function IsSchema(value) {
  return IsAny(value) || IsArgument(value) || IsArray3(value) || IsBoolean2(value) || IsBigInt2(value) || IsAsyncIterator2(value) || IsComputed(value) || IsConstructor(value) || IsDate2(value) || IsFunction2(value) || IsInteger(value) || IsIntersect(value) || IsIterator2(value) || IsLiteral(value) || IsMappedKey(value) || IsMappedResult(value) || IsNever(value) || IsNot(value) || IsNull2(value) || IsNumber3(value) || IsObject3(value) || IsPromise(value) || IsRecord(value) || IsRef(value) || IsRegExp2(value) || IsString2(value) || IsSymbol2(value) || IsTemplateLiteral(value) || IsThis(value) || IsTuple(value) || IsUndefined3(value) || IsUnion(value) || IsUint8Array2(value) || IsUnknown(value) || IsUnsafe(value) || IsVoid(value) || IsKind(value);
}
// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs
var exports_type = {};
__export(exports_type, {
  TypeGuardUnknownTypeError: () => TypeGuardUnknownTypeError,
  IsVoid: () => IsVoid2,
  IsUnsafe: () => IsUnsafe2,
  IsUnknown: () => IsUnknown2,
  IsUnionLiteral: () => IsUnionLiteral,
  IsUnion: () => IsUnion2,
  IsUndefined: () => IsUndefined4,
  IsUint8Array: () => IsUint8Array3,
  IsTuple: () => IsTuple2,
  IsTransform: () => IsTransform2,
  IsThis: () => IsThis2,
  IsTemplateLiteral: () => IsTemplateLiteral2,
  IsSymbol: () => IsSymbol3,
  IsString: () => IsString3,
  IsSchema: () => IsSchema2,
  IsRegExp: () => IsRegExp3,
  IsRef: () => IsRef2,
  IsRecursive: () => IsRecursive,
  IsRecord: () => IsRecord2,
  IsReadonly: () => IsReadonly2,
  IsProperties: () => IsProperties,
  IsPromise: () => IsPromise2,
  IsOptional: () => IsOptional2,
  IsObject: () => IsObject4,
  IsNumber: () => IsNumber4,
  IsNull: () => IsNull3,
  IsNot: () => IsNot2,
  IsNever: () => IsNever2,
  IsMappedResult: () => IsMappedResult2,
  IsMappedKey: () => IsMappedKey2,
  IsLiteralValue: () => IsLiteralValue2,
  IsLiteralString: () => IsLiteralString,
  IsLiteralNumber: () => IsLiteralNumber,
  IsLiteralBoolean: () => IsLiteralBoolean,
  IsLiteral: () => IsLiteral2,
  IsKindOf: () => IsKindOf2,
  IsKind: () => IsKind2,
  IsIterator: () => IsIterator3,
  IsIntersect: () => IsIntersect2,
  IsInteger: () => IsInteger2,
  IsImport: () => IsImport,
  IsFunction: () => IsFunction3,
  IsDate: () => IsDate3,
  IsConstructor: () => IsConstructor2,
  IsComputed: () => IsComputed2,
  IsBoolean: () => IsBoolean3,
  IsBigInt: () => IsBigInt3,
  IsAsyncIterator: () => IsAsyncIterator3,
  IsArray: () => IsArray4,
  IsArgument: () => IsArgument2,
  IsAny: () => IsAny2
});
class TypeGuardUnknownTypeError extends TypeBoxError {
}
var KnownTypes = [
  "Argument",
  "Any",
  "Array",
  "AsyncIterator",
  "BigInt",
  "Boolean",
  "Computed",
  "Constructor",
  "Date",
  "Enum",
  "Function",
  "Integer",
  "Intersect",
  "Iterator",
  "Literal",
  "MappedKey",
  "MappedResult",
  "Not",
  "Null",
  "Number",
  "Object",
  "Promise",
  "Record",
  "Ref",
  "RegExp",
  "String",
  "Symbol",
  "TemplateLiteral",
  "This",
  "Tuple",
  "Undefined",
  "Union",
  "Uint8Array",
  "Unknown",
  "Void"
];
function IsPattern(value) {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
function IsControlCharacterFree(value) {
  if (!IsString(value))
    return false;
  for (let i = 0;i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 7 && code <= 13 || code === 27 || code === 127) {
      return false;
    }
  }
  return true;
}
function IsAdditionalProperties(value) {
  return IsOptionalBoolean(value) || IsSchema2(value);
}
function IsOptionalBigInt(value) {
  return IsUndefined(value) || IsBigInt(value);
}
function IsOptionalNumber(value) {
  return IsUndefined(value) || IsNumber(value);
}
function IsOptionalBoolean(value) {
  return IsUndefined(value) || IsBoolean(value);
}
function IsOptionalString(value) {
  return IsUndefined(value) || IsString(value);
}
function IsOptionalPattern(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value) && IsPattern(value);
}
function IsOptionalFormat(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value);
}
function IsOptionalSchema(value) {
  return IsUndefined(value) || IsSchema2(value);
}
function IsReadonly2(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional2(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny2(value) {
  return IsKindOf2(value, "Any") && IsOptionalString(value.$id);
}
function IsArgument2(value) {
  return IsKindOf2(value, "Argument") && IsNumber(value.index);
}
function IsArray4(value) {
  return IsKindOf2(value, "Array") && value.type === "array" && IsOptionalString(value.$id) && IsSchema2(value.items) && IsOptionalNumber(value.minItems) && IsOptionalNumber(value.maxItems) && IsOptionalBoolean(value.uniqueItems) && IsOptionalSchema(value.contains) && IsOptionalNumber(value.minContains) && IsOptionalNumber(value.maxContains);
}
function IsAsyncIterator3(value) {
  return IsKindOf2(value, "AsyncIterator") && value.type === "AsyncIterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsBigInt3(value) {
  return IsKindOf2(value, "BigInt") && value.type === "bigint" && IsOptionalString(value.$id) && IsOptionalBigInt(value.exclusiveMaximum) && IsOptionalBigInt(value.exclusiveMinimum) && IsOptionalBigInt(value.maximum) && IsOptionalBigInt(value.minimum) && IsOptionalBigInt(value.multipleOf);
}
function IsBoolean3(value) {
  return IsKindOf2(value, "Boolean") && value.type === "boolean" && IsOptionalString(value.$id);
}
function IsComputed2(value) {
  return IsKindOf2(value, "Computed") && IsString(value.target) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema));
}
function IsConstructor2(value) {
  return IsKindOf2(value, "Constructor") && value.type === "Constructor" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsDate3(value) {
  return IsKindOf2(value, "Date") && value.type === "Date" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximumTimestamp) && IsOptionalNumber(value.exclusiveMinimumTimestamp) && IsOptionalNumber(value.maximumTimestamp) && IsOptionalNumber(value.minimumTimestamp) && IsOptionalNumber(value.multipleOfTimestamp);
}
function IsFunction3(value) {
  return IsKindOf2(value, "Function") && value.type === "Function" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsImport(value) {
  return IsKindOf2(value, "Import") && HasPropertyKey(value, "$defs") && IsObject(value.$defs) && IsProperties(value.$defs) && HasPropertyKey(value, "$ref") && IsString(value.$ref) && value.$ref in value.$defs;
}
function IsInteger2(value) {
  return IsKindOf2(value, "Integer") && value.type === "integer" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsProperties(value) {
  return IsObject(value) && Object.entries(value).every(([key, schema]) => IsControlCharacterFree(key) && IsSchema2(schema));
}
function IsIntersect2(value) {
  return IsKindOf2(value, "Intersect") && (IsString(value.type) && value.type !== "object" ? false : true) && IsArray(value.allOf) && value.allOf.every((schema) => IsSchema2(schema) && !IsTransform2(schema)) && IsOptionalString(value.type) && (IsOptionalBoolean(value.unevaluatedProperties) || IsOptionalSchema(value.unevaluatedProperties)) && IsOptionalString(value.$id);
}
function IsIterator3(value) {
  return IsKindOf2(value, "Iterator") && value.type === "Iterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsKindOf2(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralString(value) {
  return IsLiteral2(value) && IsString(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral2(value) && IsNumber(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral2(value) && IsBoolean(value.const);
}
function IsLiteral2(value) {
  return IsKindOf2(value, "Literal") && IsOptionalString(value.$id) && IsLiteralValue2(value.const);
}
function IsLiteralValue2(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsMappedKey2(value) {
  return IsKindOf2(value, "MappedKey") && IsArray(value.keys) && value.keys.every((key) => IsNumber(key) || IsString(key));
}
function IsMappedResult2(value) {
  return IsKindOf2(value, "MappedResult") && IsProperties(value.properties);
}
function IsNever2(value) {
  return IsKindOf2(value, "Never") && IsObject(value.not) && Object.getOwnPropertyNames(value.not).length === 0;
}
function IsNot2(value) {
  return IsKindOf2(value, "Not") && IsSchema2(value.not);
}
function IsNull3(value) {
  return IsKindOf2(value, "Null") && value.type === "null" && IsOptionalString(value.$id);
}
function IsNumber4(value) {
  return IsKindOf2(value, "Number") && value.type === "number" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsObject4(value) {
  return IsKindOf2(value, "Object") && value.type === "object" && IsOptionalString(value.$id) && IsProperties(value.properties) && IsAdditionalProperties(value.additionalProperties) && IsOptionalNumber(value.minProperties) && IsOptionalNumber(value.maxProperties);
}
function IsPromise2(value) {
  return IsKindOf2(value, "Promise") && value.type === "Promise" && IsOptionalString(value.$id) && IsSchema2(value.item);
}
function IsRecord2(value) {
  return IsKindOf2(value, "Record") && value.type === "object" && IsOptionalString(value.$id) && IsAdditionalProperties(value.additionalProperties) && IsObject(value.patternProperties) && ((schema) => {
    const keys = Object.getOwnPropertyNames(schema.patternProperties);
    return keys.length === 1 && IsPattern(keys[0]) && IsObject(schema.patternProperties) && IsSchema2(schema.patternProperties[keys[0]]);
  })(value);
}
function IsRecursive(value) {
  return IsObject(value) && Hint in value && value[Hint] === "Recursive";
}
function IsRef2(value) {
  return IsKindOf2(value, "Ref") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsRegExp3(value) {
  return IsKindOf2(value, "RegExp") && IsOptionalString(value.$id) && IsString(value.source) && IsString(value.flags) && IsOptionalNumber(value.maxLength) && IsOptionalNumber(value.minLength);
}
function IsString3(value) {
  return IsKindOf2(value, "String") && value.type === "string" && IsOptionalString(value.$id) && IsOptionalNumber(value.minLength) && IsOptionalNumber(value.maxLength) && IsOptionalPattern(value.pattern) && IsOptionalFormat(value.format);
}
function IsSymbol3(value) {
  return IsKindOf2(value, "Symbol") && value.type === "symbol" && IsOptionalString(value.$id);
}
function IsTemplateLiteral2(value) {
  return IsKindOf2(value, "TemplateLiteral") && value.type === "string" && IsString(value.pattern) && value.pattern[0] === "^" && value.pattern[value.pattern.length - 1] === "$";
}
function IsThis2(value) {
  return IsKindOf2(value, "This") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsTransform2(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple2(value) {
  return IsKindOf2(value, "Tuple") && value.type === "array" && IsOptionalString(value.$id) && IsNumber(value.minItems) && IsNumber(value.maxItems) && value.minItems === value.maxItems && (IsUndefined(value.items) && IsUndefined(value.additionalItems) && value.minItems === 0 || IsArray(value.items) && value.items.every((schema) => IsSchema2(schema)));
}
function IsUndefined4(value) {
  return IsKindOf2(value, "Undefined") && value.type === "undefined" && IsOptionalString(value.$id);
}
function IsUnionLiteral(value) {
  return IsUnion2(value) && value.anyOf.every((schema) => IsLiteralString(schema) || IsLiteralNumber(schema));
}
function IsUnion2(value) {
  return IsKindOf2(value, "Union") && IsOptionalString(value.$id) && IsObject(value) && IsArray(value.anyOf) && value.anyOf.every((schema) => IsSchema2(schema));
}
function IsUint8Array3(value) {
  return IsKindOf2(value, "Uint8Array") && value.type === "Uint8Array" && IsOptionalString(value.$id) && IsOptionalNumber(value.minByteLength) && IsOptionalNumber(value.maxByteLength);
}
function IsUnknown2(value) {
  return IsKindOf2(value, "Unknown") && IsOptionalString(value.$id);
}
function IsUnsafe2(value) {
  return IsKindOf2(value, "Unsafe");
}
function IsVoid2(value) {
  return IsKindOf2(value, "Void") && value.type === "void" && IsOptionalString(value.$id);
}
function IsKind2(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]) && !KnownTypes.includes(value[Kind]);
}
function IsSchema2(value) {
  return IsObject(value) && (IsAny2(value) || IsArgument2(value) || IsArray4(value) || IsBoolean3(value) || IsBigInt3(value) || IsAsyncIterator3(value) || IsComputed2(value) || IsConstructor2(value) || IsDate3(value) || IsFunction3(value) || IsInteger2(value) || IsIntersect2(value) || IsIterator3(value) || IsLiteral2(value) || IsMappedKey2(value) || IsMappedResult2(value) || IsNever2(value) || IsNot2(value) || IsNull3(value) || IsNumber4(value) || IsObject4(value) || IsPromise2(value) || IsRecord2(value) || IsRef2(value) || IsRegExp3(value) || IsString3(value) || IsSymbol3(value) || IsTemplateLiteral2(value) || IsThis2(value) || IsTuple2(value) || IsUndefined4(value) || IsUnion2(value) || IsUint8Array3(value) || IsUnknown2(value) || IsUnsafe2(value) || IsVoid2(value) || IsKind2(value));
}
// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/patterns/patterns.mjs
var PatternBoolean = "(true|false)";
var PatternNumber = "(0|[1-9][0-9]*)";
var PatternString = "(.*)";
var PatternNever = "(?!.*)";
var PatternBooleanExact = `^${PatternBoolean}$`;
var PatternNumberExact = `^${PatternNumber}$`;
var PatternStringExact = `^${PatternString}$`;
var PatternNeverExact = `^${PatternNever}$`;

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/sets/set.mjs
function SetIncludes(T, S) {
  return T.includes(S);
}
function SetDistinct(T) {
  return [...new Set(T)];
}
function SetIntersect(T, S) {
  return T.filter((L) => S.includes(L));
}
function SetIntersectManyResolve(T, Init) {
  return T.reduce((Acc, L) => {
    return SetIntersect(Acc, L);
  }, Init);
}
function SetIntersectMany(T) {
  return T.length === 1 ? T[0] : T.length > 1 ? SetIntersectManyResolve(T.slice(1), T[0]) : [];
}
function SetUnionMany(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...L);
  return Acc;
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/any/any.mjs
function Any(options) {
  return CreateType({ [Kind]: "Any" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/array/array.mjs
function Array2(items, options) {
  return CreateType({ [Kind]: "Array", type: "array", items }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/argument/argument.mjs
function Argument(index) {
  return CreateType({ [Kind]: "Argument", index });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/async-iterator/async-iterator.mjs
function AsyncIterator(items, options) {
  return CreateType({ [Kind]: "AsyncIterator", type: "AsyncIterator", items }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/computed/computed.mjs
function Computed(target, parameters, options) {
  return CreateType({ [Kind]: "Computed", target, parameters }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/discard/discard.mjs
function DiscardKey(value, key) {
  const { [key]: _, ...rest } = value;
  return rest;
}
function Discard(value, keys) {
  return keys.reduce((acc, key) => DiscardKey(acc, key), value);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/never/never.mjs
function Never(options) {
  return CreateType({ [Kind]: "Never", not: {} }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped-result.mjs
function MappedResult(properties) {
  return CreateType({
    [Kind]: "MappedResult",
    properties
  });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/constructor/constructor.mjs
function Constructor(parameters, returns, options) {
  return CreateType({ [Kind]: "Constructor", type: "Constructor", parameters, returns }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/function/function.mjs
function Function(parameters, returns, options) {
  return CreateType({ [Kind]: "Function", type: "Function", parameters, returns }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/union/union-create.mjs
function UnionCreate(T, options) {
  return CreateType({ [Kind]: "Union", anyOf: T }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/union/union-evaluated.mjs
function IsUnionOptional(types2) {
  return types2.some((type) => IsOptional(type));
}
function RemoveOptionalFromRest(types2) {
  return types2.map((left) => IsOptional(left) ? RemoveOptionalFromType(left) : left);
}
function RemoveOptionalFromType(T) {
  return Discard(T, [OptionalKind]);
}
function ResolveUnion(types2, options) {
  const isOptional = IsUnionOptional(types2);
  return isOptional ? Optional(UnionCreate(RemoveOptionalFromRest(types2), options)) : UnionCreate(RemoveOptionalFromRest(types2), options);
}
function UnionEvaluated(T, options) {
  return T.length === 1 ? CreateType(T[0], options) : T.length === 0 ? Never(options) : ResolveUnion(T, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/union/union.mjs
function Union(types2, options) {
  return types2.length === 0 ? Never(options) : types2.length === 1 ? CreateType(types2[0], options) : UnionCreate(types2, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/parse.mjs
class TemplateLiteralParserError extends TypeBoxError {
}
function Unescape(pattern) {
  return pattern.replace(/\\\$/g, "$").replace(/\\\*/g, "*").replace(/\\\^/g, "^").replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
}
function IsNonEscaped(pattern, index, char) {
  return pattern[index] === char && pattern.charCodeAt(index - 1) !== 92;
}
function IsOpenParen(pattern, index) {
  return IsNonEscaped(pattern, index, "(");
}
function IsCloseParen(pattern, index) {
  return IsNonEscaped(pattern, index, ")");
}
function IsSeparator(pattern, index) {
  return IsNonEscaped(pattern, index, "|");
}
function IsGroup(pattern) {
  if (!(IsOpenParen(pattern, 0) && IsCloseParen(pattern, pattern.length - 1)))
    return false;
  let count = 0;
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (count === 0 && index !== pattern.length - 1)
      return false;
  }
  return true;
}
function InGroup(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function IsPrecedenceOr(pattern) {
  let count = 0;
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0)
      return true;
  }
  return false;
}
function IsPrecedenceAnd(pattern) {
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      return true;
  }
  return false;
}
function Or(pattern) {
  let [count, start] = [0, 0];
  const expressions = [];
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0) {
      const range2 = pattern.slice(start, index);
      if (range2.length > 0)
        expressions.push(TemplateLiteralParse(range2));
      start = index + 1;
    }
  }
  const range = pattern.slice(start);
  if (range.length > 0)
    expressions.push(TemplateLiteralParse(range));
  if (expressions.length === 0)
    return { type: "const", const: "" };
  if (expressions.length === 1)
    return expressions[0];
  return { type: "or", expr: expressions };
}
function And(pattern) {
  function Group(value, index) {
    if (!IsOpenParen(value, index))
      throw new TemplateLiteralParserError(`TemplateLiteralParser: Index must point to open parens`);
    let count = 0;
    for (let scan = index;scan < value.length; scan++) {
      if (IsOpenParen(value, scan))
        count += 1;
      if (IsCloseParen(value, scan))
        count -= 1;
      if (count === 0)
        return [index, scan];
    }
    throw new TemplateLiteralParserError(`TemplateLiteralParser: Unclosed group parens in expression`);
  }
  function Range(pattern2, index) {
    for (let scan = index;scan < pattern2.length; scan++) {
      if (IsOpenParen(pattern2, scan))
        return [index, scan];
    }
    return [index, pattern2.length];
  }
  const expressions = [];
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index)) {
      const [start, end] = Group(pattern, index);
      const range = pattern.slice(start, end + 1);
      expressions.push(TemplateLiteralParse(range));
      index = end;
    } else {
      const [start, end] = Range(pattern, index);
      const range = pattern.slice(start, end);
      if (range.length > 0)
        expressions.push(TemplateLiteralParse(range));
      index = end - 1;
    }
  }
  return expressions.length === 0 ? { type: "const", const: "" } : expressions.length === 1 ? expressions[0] : { type: "and", expr: expressions };
}
function TemplateLiteralParse(pattern) {
  return IsGroup(pattern) ? TemplateLiteralParse(InGroup(pattern)) : IsPrecedenceOr(pattern) ? Or(pattern) : IsPrecedenceAnd(pattern) ? And(pattern) : { type: "const", const: Unescape(pattern) };
}
function TemplateLiteralParseExact(pattern) {
  return TemplateLiteralParse(pattern.slice(1, pattern.length - 1));
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/finite.mjs
class TemplateLiteralFiniteError extends TypeBoxError {
}
function IsNumberExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "0" && expression.expr[1].type === "const" && expression.expr[1].const === "[1-9][0-9]*";
}
function IsBooleanExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "true" && expression.expr[1].type === "const" && expression.expr[1].const === "false";
}
function IsStringExpression(expression) {
  return expression.type === "const" && expression.const === ".*";
}
function IsTemplateLiteralExpressionFinite(expression) {
  return IsNumberExpression(expression) || IsStringExpression(expression) ? false : IsBooleanExpression(expression) ? true : expression.type === "and" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "or" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "const" ? true : (() => {
    throw new TemplateLiteralFiniteError(`Unknown expression type`);
  })();
}
function IsTemplateLiteralFinite(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/generate.mjs
class TemplateLiteralGenerateError extends TypeBoxError {
}
function* GenerateReduce(buffer) {
  if (buffer.length === 1)
    return yield* buffer[0];
  for (const left of buffer[0]) {
    for (const right of GenerateReduce(buffer.slice(1))) {
      yield `${left}${right}`;
    }
  }
}
function* GenerateAnd(expression) {
  return yield* GenerateReduce(expression.expr.map((expr) => [...TemplateLiteralExpressionGenerate(expr)]));
}
function* GenerateOr(expression) {
  for (const expr of expression.expr)
    yield* TemplateLiteralExpressionGenerate(expr);
}
function* GenerateConst(expression) {
  return yield expression.const;
}
function* TemplateLiteralExpressionGenerate(expression) {
  return expression.type === "and" ? yield* GenerateAnd(expression) : expression.type === "or" ? yield* GenerateOr(expression) : expression.type === "const" ? yield* GenerateConst(expression) : (() => {
    throw new TemplateLiteralGenerateError("Unknown expression");
  })();
}
function TemplateLiteralGenerate(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression) ? [...TemplateLiteralExpressionGenerate(expression)] : [];
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/literal/literal.mjs
function Literal(value, options) {
  return CreateType({
    [Kind]: "Literal",
    const: value,
    type: typeof value
  }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/boolean/boolean.mjs
function Boolean2(options) {
  return CreateType({ [Kind]: "Boolean", type: "boolean" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/bigint/bigint.mjs
function BigInt(options) {
  return CreateType({ [Kind]: "BigInt", type: "bigint" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/number/number.mjs
function Number2(options) {
  return CreateType({ [Kind]: "Number", type: "number" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/string/string.mjs
function String2(options) {
  return CreateType({ [Kind]: "String", type: "string" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/syntax.mjs
function* FromUnion(syntax) {
  const trim = syntax.trim().replace(/"|'/g, "");
  return trim === "boolean" ? yield Boolean2() : trim === "number" ? yield Number2() : trim === "bigint" ? yield BigInt() : trim === "string" ? yield String2() : yield (() => {
    const literals = trim.split("|").map((literal) => Literal(literal.trim()));
    return literals.length === 0 ? Never() : literals.length === 1 ? literals[0] : UnionEvaluated(literals);
  })();
}
function* FromTerminal(syntax) {
  if (syntax[1] !== "{") {
    const L = Literal("$");
    const R = FromSyntax(syntax.slice(1));
    return yield* [L, ...R];
  }
  for (let i = 2;i < syntax.length; i++) {
    if (syntax[i] === "}") {
      const L = FromUnion(syntax.slice(2, i));
      const R = FromSyntax(syntax.slice(i + 1));
      return yield* [...L, ...R];
    }
  }
  yield Literal(syntax);
}
function* FromSyntax(syntax) {
  for (let i = 0;i < syntax.length; i++) {
    if (syntax[i] === "$") {
      const L = Literal(syntax.slice(0, i));
      const R = FromTerminal(syntax.slice(i));
      return yield* [L, ...R];
    }
  }
  yield Literal(syntax);
}
function TemplateLiteralSyntax(syntax) {
  return [...FromSyntax(syntax)];
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/pattern.mjs
class TemplateLiteralPatternError extends TypeBoxError {
}
function Escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Visit2(schema, acc) {
  return IsTemplateLiteral(schema) ? schema.pattern.slice(1, schema.pattern.length - 1) : IsUnion(schema) ? `(${schema.anyOf.map((schema2) => Visit2(schema2, acc)).join("|")})` : IsNumber3(schema) ? `${acc}${PatternNumber}` : IsInteger(schema) ? `${acc}${PatternNumber}` : IsBigInt2(schema) ? `${acc}${PatternNumber}` : IsString2(schema) ? `${acc}${PatternString}` : IsLiteral(schema) ? `${acc}${Escape(schema.const.toString())}` : IsBoolean2(schema) ? `${acc}${PatternBoolean}` : (() => {
    throw new TemplateLiteralPatternError(`Unexpected Kind '${schema[Kind]}'`);
  })();
}
function TemplateLiteralPattern(kinds) {
  return `^${kinds.map((schema) => Visit2(schema, "")).join("")}$`;
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/union.mjs
function TemplateLiteralToUnion(schema) {
  const R = TemplateLiteralGenerate(schema);
  const L = R.map((S) => Literal(S));
  return UnionEvaluated(L);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/template-literal/template-literal.mjs
function TemplateLiteral(unresolved, options) {
  const pattern = IsString(unresolved) ? TemplateLiteralPattern(TemplateLiteralSyntax(unresolved)) : TemplateLiteralPattern(unresolved);
  return CreateType({ [Kind]: "TemplateLiteral", type: "string", pattern }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-property-keys.mjs
function FromTemplateLiteral(templateLiteral) {
  const keys = TemplateLiteralGenerate(templateLiteral);
  return keys.map((key) => key.toString());
}
function FromUnion2(types2) {
  const result = [];
  for (const type of types2)
    result.push(...IndexPropertyKeys(type));
  return result;
}
function FromLiteral(literalValue) {
  return [literalValue.toString()];
}
function IndexPropertyKeys(type) {
  return [...new Set(IsTemplateLiteral(type) ? FromTemplateLiteral(type) : IsUnion(type) ? FromUnion2(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : IsNumber3(type) ? ["[number]"] : IsInteger(type) ? ["[number]"] : [])];
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-result.mjs
function FromProperties(type, properties, options) {
  const result = {};
  for (const K2 of Object.getOwnPropertyNames(properties)) {
    result[K2] = Index(type, IndexPropertyKeys(properties[K2]), options);
  }
  return result;
}
function FromMappedResult(type, mappedResult, options) {
  return FromProperties(type, mappedResult.properties, options);
}
function IndexFromMappedResult(type, mappedResult, options) {
  const properties = FromMappedResult(type, mappedResult, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed.mjs
function FromRest(types2, key) {
  return types2.map((type) => IndexFromPropertyKey(type, key));
}
function FromIntersectRest(types2) {
  return types2.filter((type) => !IsNever(type));
}
function FromIntersect(types2, key) {
  return IntersectEvaluated(FromIntersectRest(FromRest(types2, key)));
}
function FromUnionRest(types2) {
  return types2.some((L) => IsNever(L)) ? [] : types2;
}
function FromUnion3(types2, key) {
  return UnionEvaluated(FromUnionRest(FromRest(types2, key)));
}
function FromTuple(types2, key) {
  return key in types2 ? types2[key] : key === "[number]" ? UnionEvaluated(types2) : Never();
}
function FromArray(type, key) {
  return key === "[number]" ? type : Never();
}
function FromProperty(properties, propertyKey) {
  return propertyKey in properties ? properties[propertyKey] : Never();
}
function IndexFromPropertyKey(type, propertyKey) {
  return IsIntersect(type) ? FromIntersect(type.allOf, propertyKey) : IsUnion(type) ? FromUnion3(type.anyOf, propertyKey) : IsTuple(type) ? FromTuple(type.items ?? [], propertyKey) : IsArray3(type) ? FromArray(type.items, propertyKey) : IsObject3(type) ? FromProperty(type.properties, propertyKey) : Never();
}
function IndexFromPropertyKeys(type, propertyKeys) {
  return propertyKeys.map((propertyKey) => IndexFromPropertyKey(type, propertyKey));
}
function FromSchema(type, propertyKeys) {
  return UnionEvaluated(IndexFromPropertyKeys(type, propertyKeys));
}
function Index(type, key, options) {
  if (IsRef(type) || IsRef(key)) {
    const error = `Index types using Ref parameters require both Type and Key to be of TSchema`;
    if (!IsSchema(type) || !IsSchema(key))
      throw new TypeBoxError(error);
    return Computed("Index", [type, key]);
  }
  if (IsMappedResult(key))
    return IndexFromMappedResult(type, key, options);
  if (IsMappedKey(key))
    return IndexFromMappedKey(type, key, options);
  return CreateType(IsSchema(key) ? FromSchema(type, IndexPropertyKeys(key)) : FromSchema(type, key), options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-key.mjs
function MappedIndexPropertyKey(type, key, options) {
  return { [key]: Index(type, [key], Clone(options)) };
}
function MappedIndexPropertyKeys(type, propertyKeys, options) {
  return propertyKeys.reduce((result, left) => {
    return { ...result, ...MappedIndexPropertyKey(type, left, options) };
  }, {});
}
function MappedIndexProperties(type, mappedKey, options) {
  return MappedIndexPropertyKeys(type, mappedKey.keys, options);
}
function IndexFromMappedKey(type, mappedKey, options) {
  const properties = MappedIndexProperties(type, mappedKey, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/iterator/iterator.mjs
function Iterator(items, options) {
  return CreateType({ [Kind]: "Iterator", type: "Iterator", items }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/object/object.mjs
function RequiredArray(properties) {
  return globalThis.Object.keys(properties).filter((key) => !IsOptional(properties[key]));
}
function _Object(properties, options) {
  const required = RequiredArray(properties);
  const schema = required.length > 0 ? { [Kind]: "Object", type: "object", required, properties } : { [Kind]: "Object", type: "object", properties };
  return CreateType(schema, options);
}
var Object2 = _Object;

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/promise/promise.mjs
function Promise2(item, options) {
  return CreateType({ [Kind]: "Promise", type: "Promise", item }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly.mjs
function RemoveReadonly(schema) {
  return CreateType(Discard(schema, [ReadonlyKind]));
}
function AddReadonly(schema) {
  return CreateType({ ...schema, [ReadonlyKind]: "Readonly" });
}
function ReadonlyWithFlag(schema, F) {
  return F === false ? RemoveReadonly(schema) : AddReadonly(schema);
}
function Readonly(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? ReadonlyFromMappedResult(schema, F) : ReadonlyWithFlag(schema, F);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly-from-mapped-result.mjs
function FromProperties2(K, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Readonly(K[K2], F);
  return Acc;
}
function FromMappedResult2(R, F) {
  return FromProperties2(R.properties, F);
}
function ReadonlyFromMappedResult(R, F) {
  const P = FromMappedResult2(R, F);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/tuple/tuple.mjs
function Tuple(types2, options) {
  return CreateType(types2.length > 0 ? { [Kind]: "Tuple", type: "array", items: types2, additionalItems: false, minItems: types2.length, maxItems: types2.length } : { [Kind]: "Tuple", type: "array", minItems: types2.length, maxItems: types2.length }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped.mjs
function FromMappedResult3(K, P) {
  return K in P ? FromSchemaType(K, P[K]) : MappedResult(P);
}
function MappedKeyToKnownMappedResultProperties(K) {
  return { [K]: Literal(K) };
}
function MappedKeyToUnknownMappedResultProperties(P) {
  const Acc = {};
  for (const L of P)
    Acc[L] = Literal(L);
  return Acc;
}
function MappedKeyToMappedResultProperties(K, P) {
  return SetIncludes(P, K) ? MappedKeyToKnownMappedResultProperties(K) : MappedKeyToUnknownMappedResultProperties(P);
}
function FromMappedKey(K, P) {
  const R = MappedKeyToMappedResultProperties(K, P);
  return FromMappedResult3(K, R);
}
function FromRest2(K, T) {
  return T.map((L) => FromSchemaType(K, L));
}
function FromProperties3(K, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(T))
    Acc[K2] = FromSchemaType(K, T[K2]);
  return Acc;
}
function FromSchemaType(K, T) {
  const options = { ...T };
  return IsOptional(T) ? Optional(FromSchemaType(K, Discard(T, [OptionalKind]))) : IsReadonly(T) ? Readonly(FromSchemaType(K, Discard(T, [ReadonlyKind]))) : IsMappedResult(T) ? FromMappedResult3(K, T.properties) : IsMappedKey(T) ? FromMappedKey(K, T.keys) : IsConstructor(T) ? Constructor(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsFunction2(T) ? Function(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsAsyncIterator2(T) ? AsyncIterator(FromSchemaType(K, T.items), options) : IsIterator2(T) ? Iterator(FromSchemaType(K, T.items), options) : IsIntersect(T) ? Intersect(FromRest2(K, T.allOf), options) : IsUnion(T) ? Union(FromRest2(K, T.anyOf), options) : IsTuple(T) ? Tuple(FromRest2(K, T.items ?? []), options) : IsObject3(T) ? Object2(FromProperties3(K, T.properties), options) : IsArray3(T) ? Array2(FromSchemaType(K, T.items), options) : IsPromise(T) ? Promise2(FromSchemaType(K, T.item), options) : T;
}
function MappedFunctionReturnType(K, T) {
  const Acc = {};
  for (const L of K)
    Acc[L] = FromSchemaType(L, T);
  return Acc;
}
function Mapped(key, map, options) {
  const K = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const RT = map({ [Kind]: "MappedKey", keys: K });
  const R = MappedFunctionReturnType(K, RT);
  return Object2(R, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/optional/optional.mjs
function RemoveOptional(schema) {
  return CreateType(Discard(schema, [OptionalKind]));
}
function AddOptional(schema) {
  return CreateType({ ...schema, [OptionalKind]: "Optional" });
}
function OptionalWithFlag(schema, F) {
  return F === false ? RemoveOptional(schema) : AddOptional(schema);
}
function Optional(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? OptionalFromMappedResult(schema, F) : OptionalWithFlag(schema, F);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/optional/optional-from-mapped-result.mjs
function FromProperties4(P, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Optional(P[K2], F);
  return Acc;
}
function FromMappedResult4(R, F) {
  return FromProperties4(R.properties, F);
}
function OptionalFromMappedResult(R, F) {
  const P = FromMappedResult4(R, F);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-create.mjs
function IntersectCreate(T, options = {}) {
  const allObjects = T.every((schema) => IsObject3(schema));
  const clonedUnevaluatedProperties = IsSchema(options.unevaluatedProperties) ? { unevaluatedProperties: options.unevaluatedProperties } : {};
  return CreateType(options.unevaluatedProperties === false || IsSchema(options.unevaluatedProperties) || allObjects ? { ...clonedUnevaluatedProperties, [Kind]: "Intersect", type: "object", allOf: T } : { ...clonedUnevaluatedProperties, [Kind]: "Intersect", allOf: T }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-evaluated.mjs
function IsIntersectOptional(types2) {
  return types2.every((left) => IsOptional(left));
}
function RemoveOptionalFromType2(type) {
  return Discard(type, [OptionalKind]);
}
function RemoveOptionalFromRest2(types2) {
  return types2.map((left) => IsOptional(left) ? RemoveOptionalFromType2(left) : left);
}
function ResolveIntersect(types2, options) {
  return IsIntersectOptional(types2) ? Optional(IntersectCreate(RemoveOptionalFromRest2(types2), options)) : IntersectCreate(RemoveOptionalFromRest2(types2), options);
}
function IntersectEvaluated(types2, options = {}) {
  if (types2.length === 1)
    return CreateType(types2[0], options);
  if (types2.length === 0)
    return Never(options);
  if (types2.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return ResolveIntersect(types2, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect.mjs
function Intersect(types2, options) {
  if (types2.length === 1)
    return CreateType(types2[0], options);
  if (types2.length === 0)
    return Never(options);
  if (types2.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return IntersectCreate(types2, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/ref/ref.mjs
function Ref(...args) {
  const [$ref, options] = typeof args[0] === "string" ? [args[0], args[1]] : [args[0].$id, args[1]];
  if (typeof $ref !== "string")
    throw new TypeBoxError("Ref: $ref must be a string");
  return CreateType({ [Kind]: "Ref", $ref }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/awaited/awaited.mjs
function FromComputed(target, parameters) {
  return Computed("Awaited", [Computed(target, parameters)]);
}
function FromRef($ref) {
  return Computed("Awaited", [Ref($ref)]);
}
function FromIntersect2(types2) {
  return Intersect(FromRest3(types2));
}
function FromUnion4(types2) {
  return Union(FromRest3(types2));
}
function FromPromise(type) {
  return Awaited(type);
}
function FromRest3(types2) {
  return types2.map((type) => Awaited(type));
}
function Awaited(type, options) {
  return CreateType(IsComputed(type) ? FromComputed(type.target, type.parameters) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsUnion(type) ? FromUnion4(type.anyOf) : IsPromise(type) ? FromPromise(type.item) : IsRef(type) ? FromRef(type.$ref) : type, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-keys.mjs
function FromRest4(types2) {
  const result = [];
  for (const L of types2)
    result.push(KeyOfPropertyKeys(L));
  return result;
}
function FromIntersect3(types2) {
  const propertyKeysArray = FromRest4(types2);
  const propertyKeys = SetUnionMany(propertyKeysArray);
  return propertyKeys;
}
function FromUnion5(types2) {
  const propertyKeysArray = FromRest4(types2);
  const propertyKeys = SetIntersectMany(propertyKeysArray);
  return propertyKeys;
}
function FromTuple2(types2) {
  return types2.map((_, indexer) => indexer.toString());
}
function FromArray2(_) {
  return ["[number]"];
}
function FromProperties5(T) {
  return globalThis.Object.getOwnPropertyNames(T);
}
function FromPatternProperties(patternProperties) {
  if (!includePatternProperties)
    return [];
  const patternPropertyKeys = globalThis.Object.getOwnPropertyNames(patternProperties);
  return patternPropertyKeys.map((key) => {
    return key[0] === "^" && key[key.length - 1] === "$" ? key.slice(1, key.length - 1) : key;
  });
}
function KeyOfPropertyKeys(type) {
  return IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion5(type.anyOf) : IsTuple(type) ? FromTuple2(type.items ?? []) : IsArray3(type) ? FromArray2(type.items) : IsObject3(type) ? FromProperties5(type.properties) : IsRecord(type) ? FromPatternProperties(type.patternProperties) : [];
}
var includePatternProperties = false;

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof.mjs
function FromComputed2(target, parameters) {
  return Computed("KeyOf", [Computed(target, parameters)]);
}
function FromRef2($ref) {
  return Computed("KeyOf", [Ref($ref)]);
}
function KeyOfFromType(type, options) {
  const propertyKeys = KeyOfPropertyKeys(type);
  const propertyKeyTypes = KeyOfPropertyKeysToRest(propertyKeys);
  const result = UnionEvaluated(propertyKeyTypes);
  return CreateType(result, options);
}
function KeyOfPropertyKeysToRest(propertyKeys) {
  return propertyKeys.map((L) => L === "[number]" ? Number2() : Literal(L));
}
function KeyOf(type, options) {
  return IsComputed(type) ? FromComputed2(type.target, type.parameters) : IsRef(type) ? FromRef2(type.$ref) : IsMappedResult(type) ? KeyOfFromMappedResult(type, options) : KeyOfFromType(type, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-from-mapped-result.mjs
function FromProperties6(properties, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = KeyOf(properties[K2], Clone(options));
  return result;
}
function FromMappedResult5(mappedResult, options) {
  return FromProperties6(mappedResult.properties, options);
}
function KeyOfFromMappedResult(mappedResult, options) {
  const properties = FromMappedResult5(mappedResult, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/composite/composite.mjs
function CompositeKeys(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...KeyOfPropertyKeys(L));
  return SetDistinct(Acc);
}
function FilterNever(T) {
  return T.filter((L) => !IsNever(L));
}
function CompositeProperty(T, K) {
  const Acc = [];
  for (const L of T)
    Acc.push(...IndexFromPropertyKeys(L, [K]));
  return FilterNever(Acc);
}
function CompositeProperties(T, K) {
  const Acc = {};
  for (const L of K) {
    Acc[L] = IntersectEvaluated(CompositeProperty(T, L));
  }
  return Acc;
}
function Composite(T, options) {
  const K = CompositeKeys(T);
  const P = CompositeProperties(T, K);
  const R = Object2(P, options);
  return R;
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/date/date.mjs
function Date2(options) {
  return CreateType({ [Kind]: "Date", type: "Date" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/null/null.mjs
function Null(options) {
  return CreateType({ [Kind]: "Null", type: "null" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/symbol/symbol.mjs
function Symbol2(options) {
  return CreateType({ [Kind]: "Symbol", type: "symbol" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/undefined/undefined.mjs
function Undefined(options) {
  return CreateType({ [Kind]: "Undefined", type: "undefined" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/uint8array/uint8array.mjs
function Uint8Array2(options) {
  return CreateType({ [Kind]: "Uint8Array", type: "Uint8Array" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/unknown/unknown.mjs
function Unknown(options) {
  return CreateType({ [Kind]: "Unknown" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/const/const.mjs
function FromArray3(T) {
  return T.map((L) => FromValue(L, false));
}
function FromProperties7(value) {
  const Acc = {};
  for (const K of globalThis.Object.getOwnPropertyNames(value))
    Acc[K] = Readonly(FromValue(value[K], false));
  return Acc;
}
function ConditionalReadonly(T, root) {
  return root === true ? T : Readonly(T);
}
function FromValue(value, root) {
  return IsAsyncIterator(value) ? ConditionalReadonly(Any(), root) : IsIterator(value) ? ConditionalReadonly(Any(), root) : IsArray(value) ? Readonly(Tuple(FromArray3(value))) : IsUint8Array(value) ? Uint8Array2() : IsDate(value) ? Date2() : IsObject(value) ? ConditionalReadonly(Object2(FromProperties7(value)), root) : IsFunction(value) ? ConditionalReadonly(Function([], Unknown()), root) : IsUndefined(value) ? Undefined() : IsNull(value) ? Null() : IsSymbol(value) ? Symbol2() : IsBigInt(value) ? BigInt() : IsNumber(value) ? Literal(value) : IsBoolean(value) ? Literal(value) : IsString(value) ? Literal(value) : Object2({});
}
function Const(T, options) {
  return CreateType(FromValue(T, true), options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/constructor-parameters/constructor-parameters.mjs
function ConstructorParameters(schema, options) {
  return IsConstructor(schema) ? Tuple(schema.parameters, options) : Never(options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/enum/enum.mjs
function Enum(item, options) {
  if (IsUndefined(item))
    throw new Error("Enum undefined or empty");
  const values1 = globalThis.Object.getOwnPropertyNames(item).filter((key) => isNaN(key)).map((key) => item[key]);
  const values2 = [...new Set(values1)];
  const anyOf = values2.map((value) => Literal(value));
  return Union(anyOf, { ...options, [Hint]: "Enum" });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extends/extends-check.mjs
class ExtendsResolverError extends TypeBoxError {
}
var ExtendsResult;
(function(ExtendsResult2) {
  ExtendsResult2[ExtendsResult2["Union"] = 0] = "Union";
  ExtendsResult2[ExtendsResult2["True"] = 1] = "True";
  ExtendsResult2[ExtendsResult2["False"] = 2] = "False";
})(ExtendsResult || (ExtendsResult = {}));
function IntoBooleanResult(result) {
  return result === ExtendsResult.False ? result : ExtendsResult.True;
}
function Throw(message) {
  throw new ExtendsResolverError(message);
}
function IsStructuralRight(right) {
  return exports_type.IsNever(right) || exports_type.IsIntersect(right) || exports_type.IsUnion(right) || exports_type.IsUnknown(right) || exports_type.IsAny(right);
}
function StructuralRight(left, right) {
  return exports_type.IsNever(right) ? FromNeverRight(left, right) : exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsUnknown(right) ? FromUnknownRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : Throw("StructuralRight");
}
function FromAnyRight(left, right) {
  return ExtendsResult.True;
}
function FromAny(left, right) {
  return exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) && right.anyOf.some((schema) => exports_type.IsAny(schema) || exports_type.IsUnknown(schema)) ? ExtendsResult.True : exports_type.IsUnion(right) ? ExtendsResult.Union : exports_type.IsUnknown(right) ? ExtendsResult.True : exports_type.IsAny(right) ? ExtendsResult.True : ExtendsResult.Union;
}
function FromArrayRight(left, right) {
  return exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : exports_type.IsNever(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromArray4(left, right) {
  return exports_type.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsArray(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromAsyncIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsAsyncIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromBigInt(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsBigInt(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBooleanRight(left, right) {
  return exports_type.IsLiteralBoolean(left) ? ExtendsResult.True : exports_type.IsBoolean(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBoolean(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsBoolean(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromConstructor(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsConstructor(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromDate(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsDate(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromFunction(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsFunction(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromIntegerRight(left, right) {
  return exports_type.IsLiteral(left) && exports_value.IsNumber(left.const) ? ExtendsResult.True : exports_type.IsNumber(left) || exports_type.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromInteger(left, right) {
  return exports_type.IsInteger(right) || exports_type.IsNumber(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : ExtendsResult.False;
}
function FromIntersectRight(left, right) {
  return right.allOf.every((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIntersect4(left, right) {
  return left.allOf.some((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromLiteral2(left, right) {
  return exports_type.IsLiteral(right) && right.const === left.const ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsString(right) ? FromStringRight(left, right) : exports_type.IsNumber(right) ? FromNumberRight(left, right) : exports_type.IsInteger(right) ? FromIntegerRight(left, right) : exports_type.IsBoolean(right) ? FromBooleanRight(left, right) : ExtendsResult.False;
}
function FromNeverRight(left, right) {
  return ExtendsResult.False;
}
function FromNever(left, right) {
  return ExtendsResult.True;
}
function UnwrapTNot(schema) {
  let [current, depth] = [schema, 0];
  while (true) {
    if (!exports_type.IsNot(current))
      break;
    current = current.not;
    depth += 1;
  }
  return depth % 2 === 0 ? current : Unknown();
}
function FromNot(left, right) {
  return exports_type.IsNot(left) ? Visit3(UnwrapTNot(left), right) : exports_type.IsNot(right) ? Visit3(left, UnwrapTNot(right)) : Throw("Invalid fallthrough for Not");
}
function FromNull(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsNull(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumberRight(left, right) {
  return exports_type.IsLiteralNumber(left) ? ExtendsResult.True : exports_type.IsNumber(left) || exports_type.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumber(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsInteger(right) || exports_type.IsNumber(right) ? ExtendsResult.True : ExtendsResult.False;
}
function IsObjectPropertyCount(schema, count) {
  return Object.getOwnPropertyNames(schema.properties).length === count;
}
function IsObjectStringLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectSymbolLike(schema) {
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "description" in schema.properties && exports_type.IsUnion(schema.properties.description) && schema.properties.description.anyOf.length === 2 && (exports_type.IsString(schema.properties.description.anyOf[0]) && exports_type.IsUndefined(schema.properties.description.anyOf[1]) || exports_type.IsString(schema.properties.description.anyOf[1]) && exports_type.IsUndefined(schema.properties.description.anyOf[0]));
}
function IsObjectNumberLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBooleanLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBigIntLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectDateLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectUint8ArrayLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectFunctionLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectConstructorLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectArrayLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectPromiseLike(schema) {
  const then = Function([Any()], Any());
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "then" in schema.properties && IntoBooleanResult(Visit3(schema.properties["then"], then)) === ExtendsResult.True;
}
function Property(left, right) {
  return Visit3(left, right) === ExtendsResult.False ? ExtendsResult.False : exports_type.IsOptional(left) && !exports_type.IsOptional(right) ? ExtendsResult.False : ExtendsResult.True;
}
function FromObjectRight(left, right) {
  return exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : exports_type.IsNever(left) || exports_type.IsLiteralString(left) && IsObjectStringLike(right) || exports_type.IsLiteralNumber(left) && IsObjectNumberLike(right) || exports_type.IsLiteralBoolean(left) && IsObjectBooleanLike(right) || exports_type.IsSymbol(left) && IsObjectSymbolLike(right) || exports_type.IsBigInt(left) && IsObjectBigIntLike(right) || exports_type.IsString(left) && IsObjectStringLike(right) || exports_type.IsSymbol(left) && IsObjectSymbolLike(right) || exports_type.IsNumber(left) && IsObjectNumberLike(right) || exports_type.IsInteger(left) && IsObjectNumberLike(right) || exports_type.IsBoolean(left) && IsObjectBooleanLike(right) || exports_type.IsUint8Array(left) && IsObjectUint8ArrayLike(right) || exports_type.IsDate(left) && IsObjectDateLike(right) || exports_type.IsConstructor(left) && IsObjectConstructorLike(right) || exports_type.IsFunction(left) && IsObjectFunctionLike(right) ? ExtendsResult.True : exports_type.IsRecord(left) && exports_type.IsString(RecordKey(left)) ? (() => {
    return right[Hint] === "Record" ? ExtendsResult.True : ExtendsResult.False;
  })() : exports_type.IsRecord(left) && exports_type.IsNumber(RecordKey(left)) ? (() => {
    return IsObjectPropertyCount(right, 0) ? ExtendsResult.True : ExtendsResult.False;
  })() : ExtendsResult.False;
}
function FromObject(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : !exports_type.IsObject(right) ? ExtendsResult.False : (() => {
    for (const key of Object.getOwnPropertyNames(right.properties)) {
      if (!(key in left.properties) && !exports_type.IsOptional(right.properties[key])) {
        return ExtendsResult.False;
      }
      if (exports_type.IsOptional(right.properties[key])) {
        return ExtendsResult.True;
      }
      if (Property(left.properties[key], right.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })();
}
function FromPromise2(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) && IsObjectPromiseLike(right) ? ExtendsResult.True : !exports_type.IsPromise(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.item, right.item));
}
function RecordKey(schema) {
  return PatternNumberExact in schema.patternProperties ? Number2() : (PatternStringExact in schema.patternProperties) ? String2() : Throw("Unknown record key pattern");
}
function RecordValue(schema) {
  return PatternNumberExact in schema.patternProperties ? schema.patternProperties[PatternNumberExact] : (PatternStringExact in schema.patternProperties) ? schema.patternProperties[PatternStringExact] : Throw("Unable to get record value schema");
}
function FromRecordRight(left, right) {
  const [Key, Value] = [RecordKey(right), RecordValue(right)];
  return exports_type.IsLiteralString(left) && exports_type.IsNumber(Key) && IntoBooleanResult(Visit3(left, Value)) === ExtendsResult.True ? ExtendsResult.True : exports_type.IsUint8Array(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsString(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsArray(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsObject(left) ? (() => {
    for (const key of Object.getOwnPropertyNames(left.properties)) {
      if (Property(Value, left.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })() : ExtendsResult.False;
}
function FromRecord(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsRecord(right) ? ExtendsResult.False : Visit3(RecordValue(left), RecordValue(right));
}
function FromRegExp(left, right) {
  const L = exports_type.IsRegExp(left) ? String2() : left;
  const R = exports_type.IsRegExp(right) ? String2() : right;
  return Visit3(L, R);
}
function FromStringRight(left, right) {
  return exports_type.IsLiteral(left) && exports_value.IsString(left.const) ? ExtendsResult.True : exports_type.IsString(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromString(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsString(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromSymbol(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsSymbol(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromTemplateLiteral2(left, right) {
  return exports_type.IsTemplateLiteral(left) ? Visit3(TemplateLiteralToUnion(left), right) : exports_type.IsTemplateLiteral(right) ? Visit3(left, TemplateLiteralToUnion(right)) : Throw("Invalid fallthrough for TemplateLiteral");
}
function IsArrayOfTuple(left, right) {
  return exports_type.IsArray(right) && left.items !== undefined && left.items.every((schema) => Visit3(schema, right.items) === ExtendsResult.True);
}
function FromTupleRight(left, right) {
  return exports_type.IsNever(left) ? ExtendsResult.True : exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : ExtendsResult.False;
}
function FromTuple3(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : exports_type.IsArray(right) && IsArrayOfTuple(left, right) ? ExtendsResult.True : !exports_type.IsTuple(right) ? ExtendsResult.False : exports_value.IsUndefined(left.items) && !exports_value.IsUndefined(right.items) || !exports_value.IsUndefined(left.items) && exports_value.IsUndefined(right.items) ? ExtendsResult.False : exports_value.IsUndefined(left.items) && !exports_value.IsUndefined(right.items) ? ExtendsResult.True : left.items.every((schema, index) => Visit3(schema, right.items[index]) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUint8Array(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsUint8Array(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUndefined(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsVoid(right) ? FromVoidRight(left, right) : exports_type.IsUndefined(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnionRight(left, right) {
  return right.anyOf.some((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnion6(left, right) {
  return left.anyOf.every((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnknownRight(left, right) {
  return ExtendsResult.True;
}
function FromUnknown(left, right) {
  return exports_type.IsNever(right) ? FromNeverRight(left, right) : exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : exports_type.IsString(right) ? FromStringRight(left, right) : exports_type.IsNumber(right) ? FromNumberRight(left, right) : exports_type.IsInteger(right) ? FromIntegerRight(left, right) : exports_type.IsBoolean(right) ? FromBooleanRight(left, right) : exports_type.IsArray(right) ? FromArrayRight(left, right) : exports_type.IsTuple(right) ? FromTupleRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsUnknown(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoidRight(left, right) {
  return exports_type.IsUndefined(left) ? ExtendsResult.True : exports_type.IsUndefined(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoid(left, right) {
  return exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsUnknown(right) ? FromUnknownRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsVoid(right) ? ExtendsResult.True : ExtendsResult.False;
}
function Visit3(left, right) {
  return exports_type.IsTemplateLiteral(left) || exports_type.IsTemplateLiteral(right) ? FromTemplateLiteral2(left, right) : exports_type.IsRegExp(left) || exports_type.IsRegExp(right) ? FromRegExp(left, right) : exports_type.IsNot(left) || exports_type.IsNot(right) ? FromNot(left, right) : exports_type.IsAny(left) ? FromAny(left, right) : exports_type.IsArray(left) ? FromArray4(left, right) : exports_type.IsBigInt(left) ? FromBigInt(left, right) : exports_type.IsBoolean(left) ? FromBoolean(left, right) : exports_type.IsAsyncIterator(left) ? FromAsyncIterator(left, right) : exports_type.IsConstructor(left) ? FromConstructor(left, right) : exports_type.IsDate(left) ? FromDate(left, right) : exports_type.IsFunction(left) ? FromFunction(left, right) : exports_type.IsInteger(left) ? FromInteger(left, right) : exports_type.IsIntersect(left) ? FromIntersect4(left, right) : exports_type.IsIterator(left) ? FromIterator(left, right) : exports_type.IsLiteral(left) ? FromLiteral2(left, right) : exports_type.IsNever(left) ? FromNever(left, right) : exports_type.IsNull(left) ? FromNull(left, right) : exports_type.IsNumber(left) ? FromNumber(left, right) : exports_type.IsObject(left) ? FromObject(left, right) : exports_type.IsRecord(left) ? FromRecord(left, right) : exports_type.IsString(left) ? FromString(left, right) : exports_type.IsSymbol(left) ? FromSymbol(left, right) : exports_type.IsTuple(left) ? FromTuple3(left, right) : exports_type.IsPromise(left) ? FromPromise2(left, right) : exports_type.IsUint8Array(left) ? FromUint8Array(left, right) : exports_type.IsUndefined(left) ? FromUndefined(left, right) : exports_type.IsUnion(left) ? FromUnion6(left, right) : exports_type.IsUnknown(left) ? FromUnknown(left, right) : exports_type.IsVoid(left) ? FromVoid(left, right) : Throw(`Unknown left type operand '${left[Kind]}'`);
}
function ExtendsCheck(left, right) {
  return Visit3(left, right);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-result.mjs
function FromProperties8(P, Right, True, False, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extends(P[K2], Right, True, False, Clone(options));
  return Acc;
}
function FromMappedResult6(Left, Right, True, False, options) {
  return FromProperties8(Left.properties, Right, True, False, options);
}
function ExtendsFromMappedResult(Left, Right, True, False, options) {
  const P = FromMappedResult6(Left, Right, True, False, options);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extends/extends.mjs
function ExtendsResolve(left, right, trueType, falseType) {
  const R = ExtendsCheck(left, right);
  return R === ExtendsResult.Union ? Union([trueType, falseType]) : R === ExtendsResult.True ? trueType : falseType;
}
function Extends(L, R, T, F, options) {
  return IsMappedResult(L) ? ExtendsFromMappedResult(L, R, T, F, options) : IsMappedKey(L) ? CreateType(ExtendsFromMappedKey(L, R, T, F, options)) : CreateType(ExtendsResolve(L, R, T, F), options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-key.mjs
function FromPropertyKey(K, U, L, R, options) {
  return {
    [K]: Extends(Literal(K), U, L, R, Clone(options))
  };
}
function FromPropertyKeys(K, U, L, R, options) {
  return K.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey(LK, U, L, R, options) };
  }, {});
}
function FromMappedKey2(K, U, L, R, options) {
  return FromPropertyKeys(K.keys, U, L, R, options);
}
function ExtendsFromMappedKey(T, U, L, R, options) {
  const P = FromMappedKey2(T, U, L, R, options);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-template-literal.mjs
function ExcludeFromTemplateLiteral(L, R) {
  return Exclude(TemplateLiteralToUnion(L), R);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude.mjs
function ExcludeRest(L, R) {
  const excluded = L.filter((inner) => ExtendsCheck(inner, R) === ExtendsResult.False);
  return excluded.length === 1 ? excluded[0] : Union(excluded);
}
function Exclude(L, R, options = {}) {
  if (IsTemplateLiteral(L))
    return CreateType(ExcludeFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExcludeFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExcludeRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? Never() : L, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-mapped-result.mjs
function FromProperties9(P, U) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Exclude(P[K2], U);
  return Acc;
}
function FromMappedResult7(R, T) {
  return FromProperties9(R.properties, T);
}
function ExcludeFromMappedResult(R, T) {
  const P = FromMappedResult7(R, T);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-template-literal.mjs
function ExtractFromTemplateLiteral(L, R) {
  return Extract(TemplateLiteralToUnion(L), R);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extract/extract.mjs
function ExtractRest(L, R) {
  const extracted = L.filter((inner) => ExtendsCheck(inner, R) !== ExtendsResult.False);
  return extracted.length === 1 ? extracted[0] : Union(extracted);
}
function Extract(L, R, options) {
  if (IsTemplateLiteral(L))
    return CreateType(ExtractFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExtractFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExtractRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? L : Never(), options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-mapped-result.mjs
function FromProperties10(P, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extract(P[K2], T);
  return Acc;
}
function FromMappedResult8(R, T) {
  return FromProperties10(R.properties, T);
}
function ExtractFromMappedResult(R, T) {
  const P = FromMappedResult8(R, T);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/instance-type/instance-type.mjs
function InstanceType(schema, options) {
  return IsConstructor(schema) ? CreateType(schema.returns, options) : Never(options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/readonly-optional/readonly-optional.mjs
function ReadonlyOptional(schema) {
  return Readonly(Optional(schema));
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/record/record.mjs
function RecordCreateFromPattern(pattern, T, options) {
  return CreateType({ [Kind]: "Record", type: "object", patternProperties: { [pattern]: T } }, options);
}
function RecordCreateFromKeys(K, T, options) {
  const result = {};
  for (const K2 of K)
    result[K2] = T;
  return Object2(result, { ...options, [Hint]: "Record" });
}
function FromTemplateLiteralKey(K, T, options) {
  return IsTemplateLiteralFinite(K) ? RecordCreateFromKeys(IndexPropertyKeys(K), T, options) : RecordCreateFromPattern(K.pattern, T, options);
}
function FromUnionKey(key, type, options) {
  return RecordCreateFromKeys(IndexPropertyKeys(Union(key)), type, options);
}
function FromLiteralKey(key, type, options) {
  return RecordCreateFromKeys([key.toString()], type, options);
}
function FromRegExpKey(key, type, options) {
  return RecordCreateFromPattern(key.source, type, options);
}
function FromStringKey(key, type, options) {
  const pattern = IsUndefined(key.pattern) ? PatternStringExact : key.pattern;
  return RecordCreateFromPattern(pattern, type, options);
}
function FromAnyKey(_, type, options) {
  return RecordCreateFromPattern(PatternStringExact, type, options);
}
function FromNeverKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNeverExact, type, options);
}
function FromBooleanKey(_key, type, options) {
  return Object2({ true: type, false: type }, options);
}
function FromIntegerKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function FromNumberKey(_, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function Record(key, type, options = {}) {
  return IsUnion(key) ? FromUnionKey(key.anyOf, type, options) : IsTemplateLiteral(key) ? FromTemplateLiteralKey(key, type, options) : IsLiteral(key) ? FromLiteralKey(key.const, type, options) : IsBoolean2(key) ? FromBooleanKey(key, type, options) : IsInteger(key) ? FromIntegerKey(key, type, options) : IsNumber3(key) ? FromNumberKey(key, type, options) : IsRegExp2(key) ? FromRegExpKey(key, type, options) : IsString2(key) ? FromStringKey(key, type, options) : IsAny(key) ? FromAnyKey(key, type, options) : IsNever(key) ? FromNeverKey(key, type, options) : Never(options);
}
function RecordPattern(record) {
  return globalThis.Object.getOwnPropertyNames(record.patternProperties)[0];
}
function RecordKey2(type) {
  const pattern = RecordPattern(type);
  return pattern === PatternStringExact ? String2() : pattern === PatternNumberExact ? Number2() : String2({ pattern });
}
function RecordValue2(type) {
  return type.patternProperties[RecordPattern(type)];
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/instantiate/instantiate.mjs
function FromConstructor2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromFunction2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromIntersect5(args, type) {
  type.allOf = FromTypes(args, type.allOf);
  return type;
}
function FromUnion7(args, type) {
  type.anyOf = FromTypes(args, type.anyOf);
  return type;
}
function FromTuple4(args, type) {
  if (IsUndefined(type.items))
    return type;
  type.items = FromTypes(args, type.items);
  return type;
}
function FromArray5(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromAsyncIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromPromise3(args, type) {
  type.item = FromType(args, type.item);
  return type;
}
function FromObject2(args, type) {
  const mappedProperties = FromProperties11(args, type.properties);
  return { ...type, ...Object2(mappedProperties) };
}
function FromRecord2(args, type) {
  const mappedKey = FromType(args, RecordKey2(type));
  const mappedValue = FromType(args, RecordValue2(type));
  const result = Record(mappedKey, mappedValue);
  return { ...type, ...result };
}
function FromArgument(args, argument) {
  return argument.index in args ? args[argument.index] : Unknown();
}
function FromProperty2(args, type) {
  const isReadonly = IsReadonly(type);
  const isOptional = IsOptional(type);
  const mapped = FromType(args, type);
  return isReadonly && isOptional ? ReadonlyOptional(mapped) : isReadonly && !isOptional ? Readonly(mapped) : !isReadonly && isOptional ? Optional(mapped) : mapped;
}
function FromProperties11(args, properties) {
  return globalThis.Object.getOwnPropertyNames(properties).reduce((result, key) => {
    return { ...result, [key]: FromProperty2(args, properties[key]) };
  }, {});
}
function FromTypes(args, types2) {
  return types2.map((type) => FromType(args, type));
}
function FromType(args, type) {
  return IsConstructor(type) ? FromConstructor2(args, type) : IsFunction2(type) ? FromFunction2(args, type) : IsIntersect(type) ? FromIntersect5(args, type) : IsUnion(type) ? FromUnion7(args, type) : IsTuple(type) ? FromTuple4(args, type) : IsArray3(type) ? FromArray5(args, type) : IsAsyncIterator2(type) ? FromAsyncIterator2(args, type) : IsIterator2(type) ? FromIterator2(args, type) : IsPromise(type) ? FromPromise3(args, type) : IsObject3(type) ? FromObject2(args, type) : IsRecord(type) ? FromRecord2(args, type) : IsArgument(type) ? FromArgument(args, type) : type;
}
function Instantiate(type, args) {
  return FromType(args, CloneType(type));
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/integer/integer.mjs
function Integer(options) {
  return CreateType({ [Kind]: "Integer", type: "integer" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic-from-mapped-key.mjs
function MappedIntrinsicPropertyKey(K, M, options) {
  return {
    [K]: Intrinsic(Literal(K), M, Clone(options))
  };
}
function MappedIntrinsicPropertyKeys(K, M, options) {
  const result = K.reduce((Acc, L) => {
    return { ...Acc, ...MappedIntrinsicPropertyKey(L, M, options) };
  }, {});
  return result;
}
function MappedIntrinsicProperties(T, M, options) {
  return MappedIntrinsicPropertyKeys(T["keys"], M, options);
}
function IntrinsicFromMappedKey(T, M, options) {
  const P = MappedIntrinsicProperties(T, M, options);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic.mjs
function ApplyUncapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toLowerCase(), rest].join("");
}
function ApplyCapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toUpperCase(), rest].join("");
}
function ApplyUppercase(value) {
  return value.toUpperCase();
}
function ApplyLowercase(value) {
  return value.toLowerCase();
}
function FromTemplateLiteral3(schema, mode, options) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  const finite = IsTemplateLiteralExpressionFinite(expression);
  if (!finite)
    return { ...schema, pattern: FromLiteralValue(schema.pattern, mode) };
  const strings = [...TemplateLiteralExpressionGenerate(expression)];
  const literals = strings.map((value) => Literal(value));
  const mapped = FromRest5(literals, mode);
  const union = Union(mapped);
  return TemplateLiteral([union], options);
}
function FromLiteralValue(value, mode) {
  return typeof value === "string" ? mode === "Uncapitalize" ? ApplyUncapitalize(value) : mode === "Capitalize" ? ApplyCapitalize(value) : mode === "Uppercase" ? ApplyUppercase(value) : mode === "Lowercase" ? ApplyLowercase(value) : value : value.toString();
}
function FromRest5(T, M) {
  return T.map((L) => Intrinsic(L, M));
}
function Intrinsic(schema, mode, options = {}) {
  return IsMappedKey(schema) ? IntrinsicFromMappedKey(schema, mode, options) : IsTemplateLiteral(schema) ? FromTemplateLiteral3(schema, mode, options) : IsUnion(schema) ? Union(FromRest5(schema.anyOf, mode), options) : IsLiteral(schema) ? Literal(FromLiteralValue(schema.const, mode), options) : CreateType(schema, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/capitalize.mjs
function Capitalize(T, options = {}) {
  return Intrinsic(T, "Capitalize", options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/lowercase.mjs
function Lowercase(T, options = {}) {
  return Intrinsic(T, "Lowercase", options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uncapitalize.mjs
function Uncapitalize(T, options = {}) {
  return Intrinsic(T, "Uncapitalize", options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uppercase.mjs
function Uppercase(T, options = {}) {
  return Intrinsic(T, "Uppercase", options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-result.mjs
function FromProperties12(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Omit(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult9(mappedResult, propertyKeys, options) {
  return FromProperties12(mappedResult.properties, propertyKeys, options);
}
function OmitFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult9(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/omit/omit.mjs
function FromIntersect6(types2, propertyKeys) {
  return types2.map((type) => OmitResolve(type, propertyKeys));
}
function FromUnion8(types2, propertyKeys) {
  return types2.map((type) => OmitResolve(type, propertyKeys));
}
function FromProperty3(properties, key) {
  const { [key]: _, ...R } = properties;
  return R;
}
function FromProperties13(properties, propertyKeys) {
  return propertyKeys.reduce((T, K2) => FromProperty3(T, K2), properties);
}
function FromObject3(type, propertyKeys, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties13(properties, propertyKeys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function OmitResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect6(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion8(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject3(type, propertyKeys, type.properties) : Object2({});
}
function Omit(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? OmitFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? OmitFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Omit", [type, typeKey], options) : CreateType({ ...OmitResolve(type, propertyKeys), ...options });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-key.mjs
function FromPropertyKey2(type, key, options) {
  return { [key]: Omit(type, [key], Clone(options)) };
}
function FromPropertyKeys2(type, propertyKeys, options) {
  return propertyKeys.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey2(type, LK, options) };
  }, {});
}
function FromMappedKey3(type, mappedKey, options) {
  return FromPropertyKeys2(type, mappedKey.keys, options);
}
function OmitFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey3(type, mappedKey, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-result.mjs
function FromProperties14(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Pick(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult10(mappedResult, propertyKeys, options) {
  return FromProperties14(mappedResult.properties, propertyKeys, options);
}
function PickFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult10(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/pick/pick.mjs
function FromIntersect7(types2, propertyKeys) {
  return types2.map((type) => PickResolve(type, propertyKeys));
}
function FromUnion9(types2, propertyKeys) {
  return types2.map((type) => PickResolve(type, propertyKeys));
}
function FromProperties15(properties, propertyKeys) {
  const result = {};
  for (const K2 of propertyKeys)
    if (K2 in properties)
      result[K2] = properties[K2];
  return result;
}
function FromObject4(Type, keys, properties) {
  const options = Discard(Type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties15(properties, keys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys2(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function PickResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect7(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion9(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject4(type, propertyKeys, type.properties) : Object2({});
}
function Pick(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys2(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? PickFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? PickFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Pick", [type, typeKey], options) : CreateType({ ...PickResolve(type, propertyKeys), ...options });
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-key.mjs
function FromPropertyKey3(type, key, options) {
  return {
    [key]: Pick(type, [key], Clone(options))
  };
}
function FromPropertyKeys3(type, propertyKeys, options) {
  return propertyKeys.reduce((result, leftKey) => {
    return { ...result, ...FromPropertyKey3(type, leftKey, options) };
  }, {});
}
function FromMappedKey4(type, mappedKey, options) {
  return FromPropertyKeys3(type, mappedKey.keys, options);
}
function PickFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey4(type, mappedKey, options);
  return MappedResult(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/partial/partial.mjs
function FromComputed3(target, parameters) {
  return Computed("Partial", [Computed(target, parameters)]);
}
function FromRef3($ref) {
  return Computed("Partial", [Ref($ref)]);
}
function FromProperties16(properties) {
  const partialProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    partialProperties[K] = Optional(properties[K]);
  return partialProperties;
}
function FromObject5(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties16(properties);
  return Object2(mappedProperties, options);
}
function FromRest6(types2) {
  return types2.map((type) => PartialResolve(type));
}
function PartialResolve(type) {
  return IsComputed(type) ? FromComputed3(type.target, type.parameters) : IsRef(type) ? FromRef3(type.$ref) : IsIntersect(type) ? Intersect(FromRest6(type.allOf)) : IsUnion(type) ? Union(FromRest6(type.anyOf)) : IsObject3(type) ? FromObject5(type, type.properties) : IsBigInt2(type) ? type : IsBoolean2(type) ? type : IsInteger(type) ? type : IsLiteral(type) ? type : IsNull2(type) ? type : IsNumber3(type) ? type : IsString2(type) ? type : IsSymbol2(type) ? type : IsUndefined3(type) ? type : Object2({});
}
function Partial(type, options) {
  if (IsMappedResult(type)) {
    return PartialFromMappedResult(type, options);
  } else {
    return CreateType({ ...PartialResolve(type), ...options });
  }
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/partial/partial-from-mapped-result.mjs
function FromProperties17(K, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Partial(K[K2], Clone(options));
  return Acc;
}
function FromMappedResult11(R, options) {
  return FromProperties17(R.properties, options);
}
function PartialFromMappedResult(R, options) {
  const P = FromMappedResult11(R, options);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/required/required.mjs
function FromComputed4(target, parameters) {
  return Computed("Required", [Computed(target, parameters)]);
}
function FromRef4($ref) {
  return Computed("Required", [Ref($ref)]);
}
function FromProperties18(properties) {
  const requiredProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    requiredProperties[K] = Discard(properties[K], [OptionalKind]);
  return requiredProperties;
}
function FromObject6(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties18(properties);
  return Object2(mappedProperties, options);
}
function FromRest7(types2) {
  return types2.map((type) => RequiredResolve(type));
}
function RequiredResolve(type) {
  return IsComputed(type) ? FromComputed4(type.target, type.parameters) : IsRef(type) ? FromRef4(type.$ref) : IsIntersect(type) ? Intersect(FromRest7(type.allOf)) : IsUnion(type) ? Union(FromRest7(type.anyOf)) : IsObject3(type) ? FromObject6(type, type.properties) : IsBigInt2(type) ? type : IsBoolean2(type) ? type : IsInteger(type) ? type : IsLiteral(type) ? type : IsNull2(type) ? type : IsNumber3(type) ? type : IsString2(type) ? type : IsSymbol2(type) ? type : IsUndefined3(type) ? type : Object2({});
}
function Required(type, options) {
  if (IsMappedResult(type)) {
    return RequiredFromMappedResult(type, options);
  } else {
    return CreateType({ ...RequiredResolve(type), ...options });
  }
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/required/required-from-mapped-result.mjs
function FromProperties19(P, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Required(P[K2], options);
  return Acc;
}
function FromMappedResult12(R, options) {
  return FromProperties19(R.properties, options);
}
function RequiredFromMappedResult(R, options) {
  const P = FromMappedResult12(R, options);
  return MappedResult(P);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/module/compute.mjs
function DereferenceParameters(moduleProperties, types2) {
  return types2.map((type) => {
    return IsRef(type) ? Dereference(moduleProperties, type.$ref) : FromType2(moduleProperties, type);
  });
}
function Dereference(moduleProperties, ref) {
  return ref in moduleProperties ? IsRef(moduleProperties[ref]) ? Dereference(moduleProperties, moduleProperties[ref].$ref) : FromType2(moduleProperties, moduleProperties[ref]) : Never();
}
function FromAwaited(parameters) {
  return Awaited(parameters[0]);
}
function FromIndex(parameters) {
  return Index(parameters[0], parameters[1]);
}
function FromKeyOf(parameters) {
  return KeyOf(parameters[0]);
}
function FromPartial(parameters) {
  return Partial(parameters[0]);
}
function FromOmit(parameters) {
  return Omit(parameters[0], parameters[1]);
}
function FromPick(parameters) {
  return Pick(parameters[0], parameters[1]);
}
function FromRequired(parameters) {
  return Required(parameters[0]);
}
function FromComputed5(moduleProperties, target, parameters) {
  const dereferenced = DereferenceParameters(moduleProperties, parameters);
  return target === "Awaited" ? FromAwaited(dereferenced) : target === "Index" ? FromIndex(dereferenced) : target === "KeyOf" ? FromKeyOf(dereferenced) : target === "Partial" ? FromPartial(dereferenced) : target === "Omit" ? FromOmit(dereferenced) : target === "Pick" ? FromPick(dereferenced) : target === "Required" ? FromRequired(dereferenced) : Never();
}
function FromArray6(moduleProperties, type) {
  return Array2(FromType2(moduleProperties, type));
}
function FromAsyncIterator3(moduleProperties, type) {
  return AsyncIterator(FromType2(moduleProperties, type));
}
function FromConstructor3(moduleProperties, parameters, instanceType) {
  return Constructor(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, instanceType));
}
function FromFunction3(moduleProperties, parameters, returnType) {
  return Function(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, returnType));
}
function FromIntersect8(moduleProperties, types2) {
  return Intersect(FromTypes2(moduleProperties, types2));
}
function FromIterator3(moduleProperties, type) {
  return Iterator(FromType2(moduleProperties, type));
}
function FromObject7(moduleProperties, properties) {
  return Object2(globalThis.Object.keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType2(moduleProperties, properties[key]) };
  }, {}));
}
function FromRecord3(moduleProperties, type) {
  const [value, pattern] = [FromType2(moduleProperties, RecordValue2(type)), RecordPattern(type)];
  const result = CloneType(type);
  result.patternProperties[pattern] = value;
  return result;
}
function FromTransform(moduleProperties, transform) {
  return IsRef(transform) ? { ...Dereference(moduleProperties, transform.$ref), [TransformKind]: transform[TransformKind] } : transform;
}
function FromTuple5(moduleProperties, types2) {
  return Tuple(FromTypes2(moduleProperties, types2));
}
function FromUnion10(moduleProperties, types2) {
  return Union(FromTypes2(moduleProperties, types2));
}
function FromTypes2(moduleProperties, types2) {
  return types2.map((type) => FromType2(moduleProperties, type));
}
function FromType2(moduleProperties, type) {
  return IsOptional(type) ? CreateType(FromType2(moduleProperties, Discard(type, [OptionalKind])), type) : IsReadonly(type) ? CreateType(FromType2(moduleProperties, Discard(type, [ReadonlyKind])), type) : IsTransform(type) ? CreateType(FromTransform(moduleProperties, type), type) : IsArray3(type) ? CreateType(FromArray6(moduleProperties, type.items), type) : IsAsyncIterator2(type) ? CreateType(FromAsyncIterator3(moduleProperties, type.items), type) : IsComputed(type) ? CreateType(FromComputed5(moduleProperties, type.target, type.parameters)) : IsConstructor(type) ? CreateType(FromConstructor3(moduleProperties, type.parameters, type.returns), type) : IsFunction2(type) ? CreateType(FromFunction3(moduleProperties, type.parameters, type.returns), type) : IsIntersect(type) ? CreateType(FromIntersect8(moduleProperties, type.allOf), type) : IsIterator2(type) ? CreateType(FromIterator3(moduleProperties, type.items), type) : IsObject3(type) ? CreateType(FromObject7(moduleProperties, type.properties), type) : IsRecord(type) ? CreateType(FromRecord3(moduleProperties, type)) : IsTuple(type) ? CreateType(FromTuple5(moduleProperties, type.items || []), type) : IsUnion(type) ? CreateType(FromUnion10(moduleProperties, type.anyOf), type) : type;
}
function ComputeType(moduleProperties, key) {
  return key in moduleProperties ? FromType2(moduleProperties, moduleProperties[key]) : Never();
}
function ComputeModuleProperties(moduleProperties) {
  return globalThis.Object.getOwnPropertyNames(moduleProperties).reduce((result, key) => {
    return { ...result, [key]: ComputeType(moduleProperties, key) };
  }, {});
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/module/module.mjs
class TModule {
  constructor($defs) {
    const computed = ComputeModuleProperties($defs);
    const identified = this.WithIdentifiers(computed);
    this.$defs = identified;
  }
  Import(key, options) {
    const $defs = { ...this.$defs, [key]: CreateType(this.$defs[key], options) };
    return CreateType({ [Kind]: "Import", $defs, $ref: key });
  }
  WithIdentifiers($defs) {
    return globalThis.Object.getOwnPropertyNames($defs).reduce((result, key) => {
      return { ...result, [key]: { ...$defs[key], $id: key } };
    }, {});
  }
}
function Module(properties) {
  return new TModule(properties);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/not/not.mjs
function Not(type, options) {
  return CreateType({ [Kind]: "Not", not: type }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/parameters/parameters.mjs
function Parameters(schema, options) {
  return IsFunction2(schema) ? Tuple(schema.parameters, options) : Never();
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/recursive/recursive.mjs
var Ordinal = 0;
function Recursive(callback, options = {}) {
  if (IsUndefined(options.$id))
    options.$id = `T${Ordinal++}`;
  const thisType = CloneType(callback({ [Kind]: "This", $ref: `${options.$id}` }));
  thisType.$id = options.$id;
  return CreateType({ [Hint]: "Recursive", ...thisType }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/regexp/regexp.mjs
function RegExp2(unresolved, options) {
  const expr = IsString(unresolved) ? new globalThis.RegExp(unresolved) : unresolved;
  return CreateType({ [Kind]: "RegExp", type: "RegExp", source: expr.source, flags: expr.flags }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/rest/rest.mjs
function RestResolve(T) {
  return IsIntersect(T) ? T.allOf : IsUnion(T) ? T.anyOf : IsTuple(T) ? T.items ?? [] : [];
}
function Rest(T) {
  return RestResolve(T);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/return-type/return-type.mjs
function ReturnType(schema, options) {
  return IsFunction2(schema) ? CreateType(schema.returns, options) : Never(options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/transform/transform.mjs
class TransformDecodeBuilder {
  constructor(schema) {
    this.schema = schema;
  }
  Decode(decode) {
    return new TransformEncodeBuilder(this.schema, decode);
  }
}

class TransformEncodeBuilder {
  constructor(schema, decode) {
    this.schema = schema;
    this.decode = decode;
  }
  EncodeTransform(encode, schema) {
    const Encode = (value) => schema[TransformKind].Encode(encode(value));
    const Decode = (value) => this.decode(schema[TransformKind].Decode(value));
    const Codec = { Encode, Decode };
    return { ...schema, [TransformKind]: Codec };
  }
  EncodeSchema(encode, schema) {
    const Codec = { Decode: this.decode, Encode: encode };
    return { ...schema, [TransformKind]: Codec };
  }
  Encode(encode) {
    return IsTransform(this.schema) ? this.EncodeTransform(encode, this.schema) : this.EncodeSchema(encode, this.schema);
  }
}
function Transform(schema) {
  return new TransformDecodeBuilder(schema);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/unsafe/unsafe.mjs
function Unsafe(options = {}) {
  return CreateType({ [Kind]: options[Kind] ?? "Unsafe" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/void/void.mjs
function Void(options) {
  return CreateType({ [Kind]: "Void", type: "void" }, options);
}

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/type/type.mjs
var exports_type2 = {};
__export(exports_type2, {
  Void: () => Void,
  Uppercase: () => Uppercase,
  Unsafe: () => Unsafe,
  Unknown: () => Unknown,
  Union: () => Union,
  Undefined: () => Undefined,
  Uncapitalize: () => Uncapitalize,
  Uint8Array: () => Uint8Array2,
  Tuple: () => Tuple,
  Transform: () => Transform,
  TemplateLiteral: () => TemplateLiteral,
  Symbol: () => Symbol2,
  String: () => String2,
  ReturnType: () => ReturnType,
  Rest: () => Rest,
  Required: () => Required,
  RegExp: () => RegExp2,
  Ref: () => Ref,
  Recursive: () => Recursive,
  Record: () => Record,
  ReadonlyOptional: () => ReadonlyOptional,
  Readonly: () => Readonly,
  Promise: () => Promise2,
  Pick: () => Pick,
  Partial: () => Partial,
  Parameters: () => Parameters,
  Optional: () => Optional,
  Omit: () => Omit,
  Object: () => Object2,
  Number: () => Number2,
  Null: () => Null,
  Not: () => Not,
  Never: () => Never,
  Module: () => Module,
  Mapped: () => Mapped,
  Lowercase: () => Lowercase,
  Literal: () => Literal,
  KeyOf: () => KeyOf,
  Iterator: () => Iterator,
  Intersect: () => Intersect,
  Integer: () => Integer,
  Instantiate: () => Instantiate,
  InstanceType: () => InstanceType,
  Index: () => Index,
  Function: () => Function,
  Extract: () => Extract,
  Extends: () => Extends,
  Exclude: () => Exclude,
  Enum: () => Enum,
  Date: () => Date2,
  ConstructorParameters: () => ConstructorParameters,
  Constructor: () => Constructor,
  Const: () => Const,
  Composite: () => Composite,
  Capitalize: () => Capitalize,
  Boolean: () => Boolean2,
  BigInt: () => BigInt,
  Awaited: () => Awaited,
  AsyncIterator: () => AsyncIterator,
  Array: () => Array2,
  Argument: () => Argument,
  Any: () => Any
});

// apps/desktop/node_modules/@sinclair/typebox/build/esm/type/type/index.mjs
var Type = exports_type2;

// apps/desktop/src/webview/app.ts
var rpc;
function startApp(createRpc) {
  rpc = createRpc({
    requests: {},
    messages: {
      agentEvent: (payload) => {
        console.log("[webview] agentEvent received:", payload.event.type, "for runId:", payload.runId);
        eventMux.push(payload.runId, payload.event);
      },
      chatMessage: ({ sessionId, message }) => {
        if (sessionId === state.sessionId && state.agent) {
          state.agent.appendMessage(message);
        }
      },
      workflowEvent: (payload) => {
        handleWorkflowEvent(payload);
      },
      workflowFrame: (frame) => {
        state.frames.set(frame.runId, frame);
        if (state.selectedRunId === frame.runId) {
          renderRunInspector();
        }
      },
      workspaceState: (payload) => {
        handleWorkspaceState(payload);
      },
      toast: (payload) => {
        pushToast(payload.level, payload.message);
      }
    }
  });
  setupUi();
  bootstrap().then(() => {
    updateDebug("Bootstrap complete!");
    setTimeout(() => document.getElementById("debug-banner")?.remove(), 5000);
  }).catch((err) => {
    updateDebug("ERROR: " + (err?.message ?? err));
  });
}

class AsyncQueue {
  queue = [];
  resolvers = [];
  closed = false;
  push(value) {
    if (this.closed)
      return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }
  close() {
    this.closed = true;
    while (this.resolvers.length) {
      const resolver = this.resolvers.shift();
      if (resolver)
        resolver({ value: undefined, done: true });
    }
  }
  get length() {
    return this.queue.length;
  }
  get isClosed() {
    return this.closed;
  }
  async* iterator(signal) {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.closed)
        return;
      const value = await new Promise((resolve) => {
        this.resolvers.push(resolve);
      });
      if (value.done)
        return;
      yield value.value;
    }
  }
}

class AgentEventMux {
  queues = new Map;
  get(runId) {
    const existing = this.queues.get(runId);
    if (existing)
      return existing;
    const queue = new AsyncQueue;
    this.queues.set(runId, queue);
    return queue;
  }
  push(runId, event) {
    const queue = this.get(runId);
    queue.push(event);
    if (event.type === "agent_end") {
      queue.close();
    }
  }
  async* consume(runId, signal) {
    const queue = this.get(runId);
    try {
      for await (const event of queue.iterator(signal)) {
        yield event;
      }
    } finally {
      if (queue.isClosed && queue.length === 0) {
        this.queues.delete(runId);
      }
    }
  }
}
var eventMux = new AgentEventMux;

class BunAgentTransport {
  sessionId;
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
  async* run(_messages, userMessage, _config, signal) {
    const text = extractText(userMessage);
    const attachments = userMessage.attachments;
    console.log("[webview] BunAgentTransport.run() sending message:", text);
    const { runId } = await rpc.request.sendChatMessage({
      sessionId: this.sessionId,
      text,
      attachments
    });
    console.log("[webview] BunAgentTransport.run() got runId:", runId);
    const queue = eventMux.get(runId);
    if (signal) {
      signal.addEventListener("abort", () => {
        rpc.request.abortChatRun({ sessionId: this.sessionId, runId }).catch(() => {});
        queue.close();
      });
    }
    for await (const event of eventMux.consume(runId, signal)) {
      yield event;
      if (event.type === "agent_end")
        break;
    }
  }
  async* continue(_messages, _config, signal) {
    const text = "";
    const { runId } = await rpc.request.sendChatMessage({
      sessionId: this.sessionId,
      text
    });
    const queue = eventMux.get(runId);
    if (signal) {
      signal.addEventListener("abort", () => {
        rpc.request.abortChatRun({ sessionId: this.sessionId, runId }).catch(() => {});
        queue.close();
      });
    }
    for await (const event of eventMux.consume(runId, signal)) {
      yield event;
      if (event.type === "agent_end")
        break;
    }
  }
}
var TOOL_DEFS = [
  {
    name: "read",
    label: "read",
    description: "Read a file",
    parameters: Type.Object({ path: Type.String() })
  },
  {
    name: "write",
    label: "write",
    description: "Write a file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() })
  },
  {
    name: "edit",
    label: "edit",
    description: "Apply a unified diff patch",
    parameters: Type.Object({ path: Type.String(), patch: Type.String() })
  },
  {
    name: "bash",
    label: "bash",
    description: "Run a shell command",
    parameters: Type.Object({ command: Type.String() })
  },
  {
    name: "smithers.listWorkflows",
    label: "smithers.listWorkflows",
    description: "List workflows in the workspace",
    parameters: Type.Object({ root: Type.Optional(Type.String()) })
  },
  {
    name: "smithers.runWorkflow",
    label: "smithers.runWorkflow",
    description: "Run a Smithers workflow",
    parameters: Type.Object({ workflowPath: Type.String(), input: Type.Any(), focus: Type.Optional(Type.Boolean()) })
  },
  {
    name: "smithers.getRun",
    label: "smithers.getRun",
    description: "Get Smithers run status",
    parameters: Type.Object({ runId: Type.String() })
  },
  {
    name: "smithers.approveNode",
    label: "smithers.approveNode",
    description: "Approve a Smithers node",
    parameters: Type.Object({ runId: Type.String(), nodeId: Type.String(), iteration: Type.Optional(Type.Number()) })
  },
  {
    name: "smithers.denyNode",
    label: "smithers.denyNode",
    description: "Deny a Smithers node",
    parameters: Type.Object({ runId: Type.String(), nodeId: Type.String(), iteration: Type.Optional(Type.Number()) })
  },
  {
    name: "smithers.cancelRun",
    label: "smithers.cancelRun",
    description: "Cancel a Smithers run",
    parameters: Type.Object({ runId: Type.String() })
  },
  {
    name: "smithers.resumeRun",
    label: "smithers.resumeRun",
    description: "Resume a Smithers run",
    parameters: Type.Object({ runId: Type.String() })
  },
  {
    name: "smithers.getFrame",
    label: "smithers.getFrame",
    description: "Get latest Smithers frame",
    parameters: Type.Object({ runId: Type.String(), frameNo: Type.Optional(Type.Number()) })
  }
];
var state = {
  sessions: [],
  workflows: [],
  runs: [],
  runDetails: new Map,
  runEvents: new Map,
  runEventSeq: new Map,
  frames: new Map,
  outputs: new Map,
  attempts: new Map,
  toolCalls: new Map,
  activeTab: "graph",
  sidebarOpen: true,
  logQuery: "",
  logFilters: new Set(["run", "node", "approval", "revert"]),
  graphZoom: 1,
  graphPan: { x: 0, y: 0 },
  secretStatus: { openai: false, anthropic: false }
};
var appRoot;
var chatPane;
var sidebar;
var sidebarCollapsed;
var runsTab;
var workflowsTab;
var menuDropdown;
var menuButtons;
var toastContainer;
var workspaceSelect;
var sessionSelect;
var newSessionBtn;
var runWorkflowBtn;
var toggleSidebarBtn;
var sidebarOpenBtn;
var approvalBadge;
var collapsedRunBtn;
var collapsedHistoryBtn;
var tabButtons;
var contextBar;
var mentionBox;
var sessionSyncTimer = null;
var sessionSyncToken = 0;
function setupUi() {
  appRoot = document.createElement("div");
  appRoot.className = "app";
  appRoot.setAttribute("role", "application");
  appRoot.setAttribute("aria-label", "Smithers Desktop Application");
  appRoot.innerHTML = `
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <nav class="menubar" role="menubar" aria-label="Main menu">
    <button class="menu-item" data-menu="file" role="menuitem" aria-haspopup="true" aria-expanded="false">File</button>
    <button class="menu-item" data-menu="workflow" role="menuitem" aria-haspopup="true" aria-expanded="false">Workflow</button>
    <button class="menu-item" data-menu="view" role="menuitem" aria-haspopup="true" aria-expanded="false">View</button>
    <button class="menu-item" data-menu="settings" role="menuitem" aria-haspopup="true" aria-expanded="false">Settings</button>
    <button class="menu-item" data-menu="help" role="menuitem" aria-haspopup="true" aria-expanded="false">Help</button>
    <div class="menubar__spacer" aria-hidden="true"></div>
    <div class="menubar__title" aria-hidden="true">Smithers</div>
  </nav>
  <div id="menu-dropdown" class="menu-dropdown hidden" role="menu" aria-label="Dropdown menu"></div>
  <header class="toolbar" role="toolbar" aria-label="Main toolbar">
    <div class="toolbar__left">
      <h1 class="logo">Smithers</h1>
      <label for="workspace-select" class="sr-only">Select workspace</label>
      <select id="workspace-select" class="select" aria-label="Workspace selection"></select>
      <label for="session-select" class="sr-only">Select chat session</label>
      <select id="session-select" class="select" aria-label="Chat session selection"></select>
      <button id="new-session" class="btn btn-ghost" aria-label="Create new chat session">New Session</button>
    </div>
    <div class="toolbar__right">
      <button id="run-workflow" class="btn btn-primary" aria-label="Run a workflow">Run Workflow</button>
      <button id="toggle-sidebar" class="btn btn-ghost" aria-label="Toggle workflow panel visibility" aria-pressed="true">Workflow Panel</button>
    </div>
  </header>
  <div class="content" role="main" id="main-content">
    <section id="chat-pane" class="chat-pane" aria-label="Chat conversation"></section>
    <aside id="sidebar" class="sidebar" aria-label="Workflow sidebar" aria-hidden="false">
      <div class="sidebar__tabs" role="tablist" aria-label="Sidebar tabs">
        <button class="tab-btn active" data-tab="runs" role="tab" aria-selected="true" aria-controls="runs-tab" id="tab-runs">Runs</button>
        <button class="tab-btn" data-tab="workflows" role="tab" aria-selected="false" aria-controls="workflows-tab" id="tab-workflows">Workflows</button>
      </div>
      <div class="sidebar__body">
        <div id="runs-tab" class="tab-panel" role="tabpanel" aria-labelledby="tab-runs"></div>
        <div id="workflows-tab" class="tab-panel hidden" role="tabpanel" aria-labelledby="tab-workflows" aria-hidden="true"></div>
      </div>
    </aside>
    <div id="sidebar-collapsed" class="sidebar-collapsed hidden" aria-label="Collapsed sidebar controls">
      <button id="sidebar-open" class="btn btn-ghost" aria-label="Open workflow sidebar">Runs</button>
      <div id="approval-badge" class="badge hidden" role="status" aria-live="polite" aria-label="Pending approvals count">0</div>
      <div class="sidebar-collapsed__actions">
        <button id="collapsed-run" class="btn btn-primary" aria-label="Run a workflow">Run</button>
        <button id="collapsed-history" class="btn btn-ghost" aria-label="View run history">History</button>
      </div>
    </div>
  </div>
  <div id="toast-container" class="toast-container" role="status" aria-live="polite" aria-label="Notifications"></div>
`;
  document.body.style.margin = "0";
  document.body.style.height = "100vh";
  document.body.appendChild(appRoot);
  chatPane = document.getElementById("chat-pane");
  sidebar = document.getElementById("sidebar");
  sidebarCollapsed = document.getElementById("sidebar-collapsed");
  runsTab = document.getElementById("runs-tab");
  workflowsTab = document.getElementById("workflows-tab");
  menuDropdown = document.getElementById("menu-dropdown");
  menuButtons = Array.from(appRoot.querySelectorAll(".menu-item"));
  toastContainer = document.getElementById("toast-container");
  workspaceSelect = document.getElementById("workspace-select");
  sessionSelect = document.getElementById("session-select");
  newSessionBtn = document.getElementById("new-session");
  runWorkflowBtn = document.getElementById("run-workflow");
  toggleSidebarBtn = document.getElementById("toggle-sidebar");
  sidebarOpenBtn = document.getElementById("sidebar-open");
  approvalBadge = document.getElementById("approval-badge");
  collapsedRunBtn = document.getElementById("collapsed-run");
  collapsedHistoryBtn = document.getElementById("collapsed-history");
  tabButtons = Array.from(appRoot.querySelectorAll(".tab-btn"));
  contextBar = document.createElement("div");
  contextBar.className = "context-bar";
  chatPane.appendChild(contextBar);
  mentionBox = document.createElement("div");
  mentionBox.className = "mention-box hidden";
  chatPane.appendChild(mentionBox);
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", String(isActive));
      });
      if (btn.dataset.tab === "runs") {
        runsTab.classList.remove("hidden");
        runsTab.removeAttribute("aria-hidden");
        workflowsTab.classList.add("hidden");
        workflowsTab.setAttribute("aria-hidden", "true");
      } else {
        runsTab.classList.add("hidden");
        runsTab.setAttribute("aria-hidden", "true");
        workflowsTab.classList.remove("hidden");
        workflowsTab.removeAttribute("aria-hidden");
      }
    });
  }
  for (const btn of menuButtons) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = btn.dataset.menu;
      if (!key)
        return;
      openMenu(key, btn);
    });
  }
  document.addEventListener("click", () => {
    closeMenu();
  });
  newSessionBtn.addEventListener("click", async () => {
    const result = await rpc.request.createChatSession({ title: "New Session" });
    await loadSessions();
    await bootstrapSession(result.sessionId);
  });
  runWorkflowBtn.addEventListener("click", () => {
    openRunDialog();
  });
  toggleSidebarBtn.addEventListener("click", () => {
    toggleSidebar();
  });
  sidebarOpenBtn.addEventListener("click", () => {
    toggleSidebar(true);
  });
  collapsedRunBtn.addEventListener("click", () => {
    openRunDialog();
  });
  collapsedHistoryBtn.addEventListener("click", () => {
    switchTab("runs");
    toggleSidebar(true);
  });
  workspaceSelect.addEventListener("change", () => {
    const value = workspaceSelect.value;
    if (value === "__open__") {
      openWorkspaceDialog();
      return;
    }
    if (value === "__close__") {
      rpc.request.openWorkspace({ path: "" }).then(() => loadWorkspaceState());
      return;
    }
    if (value) {
      rpc.request.openWorkspace({ path: value }).then(() => loadWorkspaceState());
    }
  });
  sessionSelect.addEventListener("change", () => {
    const sessionId = sessionSelect.value;
    if (sessionId) {
      bootstrapSession(sessionId).catch(console.error);
    }
  });
  window.addEventListener("keydown", (event) => {
    handleShortcuts(event);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth < 1200) {
      sidebar.classList.add("sidebar--overlay");
    } else {
      sidebar.classList.remove("sidebar--overlay");
    }
  });
  if (window.innerWidth < 1200) {
    sidebar.classList.add("sidebar--overlay");
  }
  const debugEl = document.createElement("div");
  debugEl.style.cssText = "position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;z-index:99999;font-family:monospace";
  debugEl.id = "debug-banner";
  debugEl.textContent = "DEBUG: Script loaded...";
  document.body.appendChild(debugEl);
}
function updateDebug(msg) {
  const el = document.getElementById("debug-banner");
  if (el)
    el.textContent = msg;
}
async function bootstrap() {
  updateDebug("Bootstrap: getting settings...");
  const settings = await rpc.request.getSettings({});
  state.secretStatus = await rpc.request.getSecretStatus({});
  updateDebug("Got settings, applying...");
  applySettings(settings);
  updateDebug("Loading sessions...");
  await loadSessions();
  updateDebug("Loaded " + state.sessions.length + " sessions");
  if (state.sessionId) {
    updateDebug("Bootstrapping existing session...");
    await bootstrapSession(state.sessionId);
  } else if (state.sessions.length) {
    updateDebug("Bootstrapping first session...");
    await bootstrapSession(state.sessions[0].sessionId);
  } else {
    updateDebug("Creating new session...");
    const session = await rpc.request.createChatSession({ title: "New Session" });
    await loadSessions();
    await bootstrapSession(session.sessionId);
  }
  updateDebug("Loading workspace state...");
  await loadWorkspaceState();
  updateDebug("Refreshing runs...");
  await refreshRuns();
  updateDebug("Bootstrap complete!");
}
async function loadSessions() {
  const sessions = await rpc.request.listChatSessions({});
  state.sessions = sessions;
  sessionSelect.innerHTML = "";
  sessions.forEach((s) => {
    const option = document.createElement("option");
    option.value = s.sessionId;
    option.textContent = s.title ?? s.sessionId.slice(0, 6);
    sessionSelect.appendChild(option);
  });
}
async function bootstrapSession(sessionId) {
  state.sessionId = sessionId;
  sessionSelect.value = sessionId;
  const session = await rpc.request.getChatSession({ sessionId });
  const transport = new BunAgentTransport(sessionId);
  const agent = new ChatAgent({
    transport,
    initialState: {
      messages: session.messages ?? []
    }
  });
  state.agent = agent;
  chatPane.innerHTML = "";
  chatPane.appendChild(contextBar);
  if (mentionBox && mentionBox.parentElement !== chatPane) {
    chatPane.appendChild(mentionBox);
  }
  const chatPanel = new ChatPanel;
  chatPanel.style.flex = "1";
  chatPanel.style.minHeight = "0";
  chatPane.appendChild(chatPanel);
  chatPanel.setAgent(agent);
  chatPanel.addEventListener("workflow-card-action", (event) => {
    const detail = event.detail;
    if (!detail)
      return;
    if (detail.action === "focus") {
      focusRun(detail.runId);
    } else if (detail.action === "approve" && detail.nodeId) {
      approveFromCard(detail.runId, detail.nodeId, detail.iteration ?? 0);
    } else if (detail.action === "deny" && detail.nodeId) {
      denyFromCard(detail.runId, detail.nodeId, detail.iteration ?? 0);
    }
  });
  setupMentions(chatPanel);
  renderContextBar();
  startSessionSync(sessionId);
}
function startSessionSync(sessionId) {
  sessionSyncToken += 1;
  const token = sessionSyncToken;
  if (sessionSyncTimer) {
    clearInterval(sessionSyncTimer);
  }
  let lastCount = state.agent?.state.messages.length ?? 0;
  const sync = async () => {
    if (token !== sessionSyncToken)
      return;
    if (state.sessionId !== sessionId)
      return;
    const agent = state.agent;
    if (!agent || agent.state.isStreaming)
      return;
    try {
      const session = await rpc.request.getChatSession({ sessionId });
      const messages = session.messages ?? [];
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        agent.replaceMessages(messages);
      }
    } catch {}
  };
  sync();
  sessionSyncTimer = setInterval(sync, 1000);
}
function setupMentions(chatPanel) {
  const root = chatPanel.shadowRoot ?? chatPanel;
  const textarea = root.querySelector("textarea");
  if (!textarea)
    return;
  const updateMentions = () => {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const workflowMatch = /@workflow\(?([^\s)]*)$/.exec(before);
    const runMatch = /#run\(?([^\s)]*)$/.exec(before);
    let items = [];
    let match = null;
    if (workflowMatch) {
      match = workflowMatch;
      const query = (workflowMatch[1] ?? "").toLowerCase();
      items = state.workflows.filter((wf) => (wf.path ?? "").toLowerCase().includes(query)).slice(0, 6).map((wf) => ({
        label: wf.name ?? wf.path,
        value: `@workflow(${wf.path})`
      }));
    } else if (runMatch) {
      match = runMatch;
      const query = (runMatch[1] ?? "").toLowerCase();
      items = state.runs.filter((run) => run.runId.toLowerCase().includes(query)).slice(0, 6).map((run) => ({
        label: run.runId.slice(0, 8),
        value: `#run(${run.runId})`
      }));
    }
    if (!match || items.length === 0) {
      mentionBox.classList.add("hidden");
      mentionBox.innerHTML = "";
      return;
    }
    mentionBox.innerHTML = items.map((item) => `<button class="mention-item" data-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`).join("");
    mentionBox.classList.remove("hidden");
    const rect = textarea.getBoundingClientRect();
    const parentRect = chatPane.getBoundingClientRect();
    mentionBox.style.left = `${rect.left - parentRect.left}px`;
    mentionBox.style.top = `${rect.top - parentRect.top - 140}px`;
    mentionBox.querySelectorAll(".mention-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.value ?? "";
        const start = match ? match.index : before.length;
        const newValue = value.slice(0, start) + val + value.slice(cursor);
        textarea.value = newValue;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        mentionBox.classList.add("hidden");
      });
    });
  };
  textarea.addEventListener("input", updateMentions);
  textarea.addEventListener("blur", () => {
    setTimeout(() => mentionBox.classList.add("hidden"), 200);
  });
}
async function loadWorkspaceState() {
  const ws = await rpc.request.getWorkspaceState({});
  handleWorkspaceState(ws);
}
async function refreshRuns() {
  const runs = await rpc.request.listRuns({ status: "all" });
  state.runs = state.workspaceRoot ? runs.filter((run) => run.workspaceRoot === state.workspaceRoot) : runs;
  if (state.selectedRunId && !state.runs.find((r) => r.runId === state.selectedRunId)) {
    state.selectedRunId = undefined;
    state.contextRunId = undefined;
  }
  updateApprovalBadge();
  renderRuns();
}
function renderRuns() {
  const selected = state.selectedRunId;
  runsTab.innerHTML = `
    <div class="panel">
      <h3 class="panel__header" id="runs-list-heading">Runs</h3>
      <div class="panel__body" id="runs-list" role="list" aria-labelledby="runs-list-heading"></div>
      <div id="run-inspector" class="run-inspector" role="region" aria-label="Run details"></div>
    </div>
  `;
  const list = runsTab.querySelector("#runs-list");
  state.runs.forEach((run) => {
    const row = document.createElement("div");
    row.className = `run-row status-${run.status}`;
    row.setAttribute("role", "listitem");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", `${run.workflowName} run, status: ${run.status}`);
    const activeNode = run.activeNodes && run.activeNodes.length ? run.activeNodes[0] : null;
    const approvals = run.waitingApprovals ?? 0;
    row.innerHTML = `
      <div class="run-row__status" aria-hidden="true"></div>
      <div class="run-row__info">
        <div class="run-row__title">${run.workflowName}</div>
        <div class="run-row__meta">
          <span class="mono">${run.runId.slice(0, 6)}</span>
          <span>• ${formatTime(run.startedAtMs)}</span>
          <span>• ${formatDuration(run.startedAtMs, run.finishedAtMs ?? null)}</span>
          ${activeNode ? `<span>• Active: <span class="mono">${activeNode}</span></span>` : ""}
          ${approvals ? `<span class="badge badge-inline" aria-label="${approvals} pending approvals">${approvals} approvals</span>` : ""}
        </div>
      </div>
      <div class="run-row__actions">
        <button class="btn btn-ghost" data-action="open" aria-label="Open run details for ${run.workflowName}">Open</button>
        ${run.status === "running" ? `<button class="btn btn-ghost" data-action="cancel" aria-label="Cancel this run">Cancel</button>` : ""}
        ${run.status === "waiting-approval" ? `<button class="btn btn-ghost" data-action="resume" aria-label="Resume this run">Resume</button>` : ""}
        <button class="btn btn-ghost" data-action="copy" aria-label="Copy run ID to clipboard">Copy ID</button>
      </div>
    `;
    row.addEventListener("click", () => focusRun(run.runId));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusRun(run.runId);
      }
    });
    row.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = btn.dataset.action;
        if (action === "open") {
          focusRun(run.runId);
        } else if (action === "cancel") {
          rpc.request.cancelRun({ runId: run.runId }).catch(() => {});
        } else if (action === "resume") {
          rpc.request.resumeRun({ runId: run.runId }).catch(() => {});
        } else if (action === "copy") {
          navigator.clipboard?.writeText(run.runId).catch(() => {});
          pushToast("info", "Run ID copied to clipboard");
        }
      });
    });
    list.appendChild(row);
  });
  if (selected) {
    renderRunInspector();
  }
}
function renderWorkflows() {
  workflowsTab.innerHTML = `
    <div class="panel">
      <div class="panel__header">Workflows</div>
      <div class="panel__body" id="workflow-list"></div>
    </div>
  `;
  const list = workflowsTab.querySelector("#workflow-list");
  if (!state.workflows.length) {
    list.innerHTML = `<div class="empty">No workflows found. Open a workspace to scan for .tsx workflows.</div>`;
    return;
  }
  state.workflows.forEach((wf) => {
    const row = document.createElement("div");
    row.className = "workflow-row";
    row.innerHTML = `
      <div>
        <div class="workflow-row__title">${wf.name ?? wf.path}</div>
        <div class="workflow-row__meta">${wf.path}</div>
      </div>
      <button class="btn btn-primary">Run</button>
    `;
    const btn = row.querySelector("button");
    btn.addEventListener("click", () => openRunDialog(wf));
    list.appendChild(row);
  });
}
async function focusRun(runId) {
  state.selectedRunId = runId;
  state.contextRunId = runId;
  state.sidebarOpen = true;
  sidebar.classList.remove("sidebar--closed");
  renderContextBar();
  const detail = await rpc.request.getRun({ runId });
  state.runDetails.set(runId, detail);
  const events = await rpc.request.getRunEvents({ runId, afterSeq: -1 });
  state.runEvents.set(runId, events.events);
  state.runEventSeq.set(runId, events.lastSeq);
  try {
    const frame = await rpc.request.getFrame({ runId });
    state.frames.set(runId, frame);
  } catch {}
  await renderRunInspector();
}
function renderContextBar() {
  const runId = state.contextRunId;
  const run = runId ? state.runs.find((r) => r.runId === runId) : undefined;
  const workspaceLabel = state.workspaceRoot ? shortenPath(state.workspaceRoot) : "None";
  contextBar.innerHTML = `
    <div class="context-chip">Workspace: <span class="mono">${workspaceLabel}</span></div>
    ${run ? `<div class="context-chip">Run: <span class="mono">${run.runId.slice(0, 6)}</span><button class="chip-btn" data-clear="run">x</button></div>` : ""}
  `;
  const clearBtn = contextBar.querySelector("[data-clear='run']");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.contextRunId = undefined;
      renderContextBar();
    });
  }
}
async function renderRunInspector() {
  const runId = state.selectedRunId;
  const container = runsTab.querySelector("#run-inspector");
  if (!runId || !container)
    return;
  const detail = state.runDetails.get(runId) ?? await rpc.request.getRun({ runId });
  state.runDetails.set(runId, detail);
  const approvals = detail.nodes.filter((n) => n.state === "waiting-approval");
  container.innerHTML = `
    <div class="run-header">
      <div>
        <div class="run-header__title">${detail.run.workflowName}</div>
        <div class="run-header__meta">
          <span class="mono">${detail.run.runId}</span>
          <span>• ${detail.run.status}</span>
          <span>• ${formatTime(detail.run.startedAtMs)}</span>
          <span>• ${formatDuration(detail.run.startedAtMs, detail.run.finishedAtMs ?? null)}</span>
          ${approvals.length ? `<span class="badge badge-inline">${approvals.length} approvals</span>` : ""}
        </div>
      </div>
      <div class="run-header__actions">
        <button class="btn btn-ghost" id="run-cancel">Cancel</button>
        <button class="btn btn-ghost" id="run-resume">Resume</button>
      </div>
    </div>
    ${approvals.length ? renderApprovalCard(approvals) : ""}
    <div class="run-tabs">
      <button class="run-tab ${state.activeTab === "graph" ? "active" : ""}" data-tab="graph">Graph</button>
      <button class="run-tab ${state.activeTab === "timeline" ? "active" : ""}" data-tab="timeline">Timeline</button>
      <button class="run-tab ${state.activeTab === "logs" ? "active" : ""}" data-tab="logs">Logs</button>
      <button class="run-tab ${state.activeTab === "outputs" ? "active" : ""}" data-tab="outputs">Outputs</button>
      <button class="run-tab ${state.activeTab === "attempts" ? "active" : ""}" data-tab="attempts">Attempts</button>
    </div>
    <div class="run-tab-body"></div>
  `;
  container.querySelectorAll(".run-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      renderRunInspector();
    });
  });
  const cancelBtn = container.querySelector("#run-cancel");
  const resumeBtn = container.querySelector("#run-resume");
  cancelBtn?.addEventListener("click", () => rpc.request.cancelRun({ runId }));
  resumeBtn?.addEventListener("click", () => rpc.request.resumeRun({ runId }));
  container.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.approve;
      const iteration = Number(btn.dataset.iter ?? 0);
      await rpc.request.approveNode({ runId, nodeId, iteration });
      await refreshRuns();
      await focusRun(runId);
    });
  });
  container.querySelectorAll("[data-deny]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.deny;
      const iteration = Number(btn.dataset.iter ?? 0);
      await rpc.request.denyNode({ runId, nodeId, iteration });
      await refreshRuns();
      await focusRun(runId);
    });
  });
  container.querySelectorAll("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.ask;
      const iteration = Number(btn.dataset.iter ?? 0);
      await askAgentAboutNode(runId, nodeId, iteration);
    });
  });
  const body = container.querySelector(".run-tab-body");
  if (!body)
    return;
  if (state.activeTab === "graph") {
    body.innerHTML = renderGraph(runId);
    attachGraphHandlers(body, runId);
  } else if (state.activeTab === "timeline") {
    body.innerHTML = renderTimeline(runId);
  } else if (state.activeTab === "logs") {
    body.innerHTML = renderLogs(runId);
    attachLogsHandlers(body, runId);
  } else if (state.activeTab === "outputs") {
    body.innerHTML = await renderOutputs(runId);
  } else if (state.activeTab === "attempts") {
    body.innerHTML = await renderAttempts(runId);
  }
}
function renderApprovalCard(approvals) {
  return `
    <div class="approval-card">
      <div class="approval-card__title">Approval Required</div>
      ${approvals.map((a) => `
        <div class="approval-row">
          <div><span class="mono">${a.nodeId}</span> (iteration ${a.iteration})</div>
          <div class="approval-actions">
            <button class="btn btn-primary" data-approve="${a.nodeId}" data-iter="${a.iteration}">Approve</button>
            <button class="btn btn-danger" data-deny="${a.nodeId}" data-iter="${a.iteration}">Deny</button>
            <button class="btn btn-ghost" data-ask="${a.nodeId}" data-iter="${a.iteration}">Ask agent</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}
function renderGraph(runId) {
  const frame = state.frames.get(runId);
  if (!frame) {
    return `<div class="empty" role="status">No frame data yet.</div>`;
  }
  const svg = buildGraphSvg(frame);
  const transform = `transform: translate(${state.graphPan.x}px, ${state.graphPan.y}px) scale(${state.graphZoom});`;
  return `
    <div class="graph" role="img" aria-label="Workflow execution graph">
      <div class="graph-toolbar" role="toolbar" aria-label="Graph controls">
        <button class="btn btn-ghost" data-graph-action="zoom-in" aria-label="Zoom in">+</button>
        <button class="btn btn-ghost" data-graph-action="zoom-out" aria-label="Zoom out">-</button>
        <button class="btn btn-ghost" data-graph-action="fit" aria-label="Fit graph to view">Fit</button>
      </div>
      <div class="graph-viewport" tabindex="0" aria-label="Graph viewport, drag to pan">
        <div class="graph-canvas" style="${transform}">
          ${svg}
        </div>
      </div>
    </div>
    <div id="node-drawer" class="node-drawer" role="complementary" aria-label="Node details"></div>
  `;
}
function renderTimeline(runId) {
  const events = state.runEvents.get(runId) ?? [];
  return `
    <div class="timeline">
      ${events.map((e) => `
        <div class="timeline-row">
          <div class="timeline-time">${formatTime(e.timestampMs)}</div>
          <div class="timeline-event">${escapeHtml(formatEvent(e))}</div>
        </div>
      `).join("")}
    </div>
  `;
}
function renderLogs(runId) {
  const events = filterEvents(runId);
  return `
    <div class="logs-toolbar">
      <input id="logs-search" class="input" placeholder="Search logs" value="${state.logQuery}" />
      <div class="logs-filters">
        ${renderLogFilter("run", "Run")}
        ${renderLogFilter("node", "Node")}
        ${renderLogFilter("approval", "Approval")}
        ${renderLogFilter("revert", "Revert")}
      </div>
      <div class="logs-actions">
        <button class="btn btn-ghost" id="logs-copy">Copy filtered</button>
        <button class="btn btn-ghost" id="logs-export">Export JSONL</button>
      </div>
    </div>
    <pre class="logs">${escapeHtml(events.map((e) => JSON.stringify(e)).join(`
`))}</pre>
  `;
}
function renderLogFilter(key, label) {
  const active = state.logFilters.has(key);
  return `<button class="btn btn-ghost logs-filter ${active ? "active" : ""}" data-filter="${key}">${label}</button>`;
}
function filterEvents(runId) {
  const events = state.runEvents.get(runId) ?? [];
  const query = state.logQuery.trim().toLowerCase();
  return events.filter((event) => {
    const group = eventGroup(event.type);
    if (!state.logFilters.has(group))
      return false;
    if (!query)
      return true;
    return JSON.stringify(event).toLowerCase().includes(query);
  });
}
function eventGroup(type) {
  if (type.startsWith("Run"))
    return "run";
  if (type.startsWith("Node"))
    return "node";
  if (type.startsWith("Approval"))
    return "approval";
  if (type.startsWith("Revert"))
    return "revert";
  return "node";
}
function attachLogsHandlers(container, runId) {
  const search = container.querySelector("#logs-search");
  const copyBtn = container.querySelector("#logs-copy");
  const exportBtn = container.querySelector("#logs-export");
  const filterButtons = container.querySelectorAll(".logs-filter");
  search?.addEventListener("input", () => {
    state.logQuery = search.value;
    renderRunInspector();
  });
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter;
      if (!key)
        return;
      if (state.logFilters.has(key)) {
        state.logFilters.delete(key);
      } else {
        state.logFilters.add(key);
      }
      renderRunInspector();
    });
  });
  copyBtn?.addEventListener("click", async () => {
    const events = filterEvents(runId);
    await navigator.clipboard?.writeText(events.map((e) => JSON.stringify(e)).join(`
`));
    pushToast("info", "Filtered logs copied.");
  });
  exportBtn?.addEventListener("click", () => {
    const events = filterEvents(runId);
    const blob = new Blob([events.map((e) => JSON.stringify(e)).join(`
`)], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run-${runId}-logs.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
async function renderOutputs(runId) {
  let data = state.outputs.get(runId);
  if (!data) {
    data = await rpc.request.getRunOutputs({ runId });
    state.outputs.set(runId, data);
  }
  if (!data.tables.length) {
    return `<div class="empty">No outputs available.</div>`;
  }
  return `
    <div class="outputs">
      ${data.tables.map((t) => `
        <div class="output-table">
          <div class="output-table__title">${escapeHtml(t.name)} (${t.rows.length})</div>
          <pre>${escapeHtml(JSON.stringify(t.rows, null, 2))}</pre>
        </div>
      `).join("")}
    </div>
  `;
}
async function renderAttempts(runId) {
  let data = state.attempts.get(runId);
  if (!data) {
    data = await rpc.request.getRunAttempts({ runId });
    state.attempts.set(runId, data);
  }
  if (!data.attempts.length) {
    return `<div class="empty">No attempts logged.</div>`;
  }
  return `
    <div class="attempts">
      ${data.attempts.map((a) => `
        <div class="attempt-row">
          <div class="attempt-row__meta">
            <div class="mono">${a.nodeId}</div>
            <div>iter ${a.iteration} - attempt ${a.attempt}</div>
            ${a.jjPointer ? `<div class="muted">JJ: ${a.jjPointer}</div>` : ""}
            ${a.errorJson ? `<div class="muted">Error: ${truncate(String(a.errorJson), 140)}</div>` : ""}
          </div>
          <div class="attempt-row__state">${a.state}</div>
        </div>
      `).join("")}
    </div>
  `;
}
function buildGraphSvg(frame) {
  const nodes = frame.graph.nodes;
  const edges = frame.graph.edges;
  const spacingX = 180;
  const spacingY = 90;
  const positions = new Map;
  nodes.forEach((node, index) => {
    const depth = node.kind === "Workflow" ? 0 : node.kind === "Task" ? 2 : 1;
    positions.set(node.id, { x: depth * spacingX + 40, y: index * spacingY + 40 });
  });
  const width = Math.max(600, ...Array.from(positions.values()).map((p) => p.x + 160));
  const height = Math.max(400, ...Array.from(positions.values()).map((p) => p.y + 80));
  const nodeSvg = nodes.map((node) => {
    const pos = positions.get(node.id);
    const color = stateColor(node.state ?? "pending");
    return `
        <g class="graph-node" data-node-id="${node.id}">
          <rect data-node-id="${node.id}" x="${pos.x}" y="${pos.y}" rx="10" ry="10" width="140" height="48" fill="${color.bg}" stroke="${color.stroke}" />
          <text x="${pos.x + 12}" y="${pos.y + 28}" fill="#e9eaf0" font-size="12">${node.label}</text>
        </g>
      `;
  }).join("");
  const edgeSvg = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to)
      return "";
    const x1 = from.x + 140;
    const y1 = from.y + 24;
    const x2 = to.x;
    const y2 = to.y + 24;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a3f4b" stroke-width="2" />`;
  }).join("");
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${edgeSvg}
      ${nodeSvg}
    </svg>
  `;
}
function handleWorkflowEvent(payload) {
  const runId = payload.runId;
  const list = state.runEvents.get(runId) ?? [];
  const lastSeq = state.runEventSeq.get(runId);
  if (lastSeq !== undefined && payload.seq > lastSeq + 1) {
    rpc.request.getRunEvents({ runId, afterSeq: lastSeq }).then((res) => {
      const merged = list.concat(res.events);
      state.runEvents.set(runId, merged);
      state.runEventSeq.set(runId, res.lastSeq);
      if (state.selectedRunId === runId) {
        renderRunInspector();
      }
    });
  } else {
    list.push(payload);
    state.runEvents.set(runId, list);
    state.runEventSeq.set(runId, payload.seq);
  }
  refreshRuns();
  if (state.selectedRunId === runId) {
    renderRunInspector();
  }
}
function handleWorkspaceState(payload) {
  state.workspaceRoot = payload.root;
  state.workflows = payload.workflows;
  updateWorkspaceSelect();
  renderWorkflows();
  renderContextBar();
  refreshRuns();
}
function applySettings(settings) {
  state.settings = settings;
  state.sidebarOpen = settings.ui.workflowPanel.isOpen;
  sidebar.style.width = `${settings.ui.workflowPanel.width}px`;
  sidebar.classList.toggle("sidebar--closed", !state.sidebarOpen);
  sidebarCollapsed.classList.toggle("hidden", state.sidebarOpen);
  document.body.classList.toggle("artifacts-hidden", !settings.ui.artifactsPanelOpen);
}
function updateWorkspaceSelect() {
  workspaceSelect.innerHTML = "";
  const root = state.workspaceRoot;
  const current = document.createElement("option");
  current.value = root ?? "";
  current.textContent = root ? shortenPath(root) : "No workspace";
  workspaceSelect.appendChild(current);
  const open = document.createElement("option");
  open.value = "__open__";
  open.textContent = "Open workspace…";
  workspaceSelect.appendChild(open);
  const close = document.createElement("option");
  close.value = "__close__";
  close.textContent = "Close workspace";
  workspaceSelect.appendChild(close);
  workspaceSelect.value = root ?? "";
}
function updateApprovalBadge() {
  const count = state.runs.reduce((sum, run) => sum + (run.waitingApprovals ?? 0), 0);
  if (count > 0) {
    approvalBadge.textContent = String(count);
    approvalBadge.setAttribute("aria-label", `${count} pending approval${count !== 1 ? "s" : ""}`);
    approvalBadge.classList.remove("hidden");
  } else {
    approvalBadge.classList.add("hidden");
  }
}
function switchTab(tab) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "runs") {
    runsTab.classList.remove("hidden");
    workflowsTab.classList.add("hidden");
  } else {
    runsTab.classList.add("hidden");
    workflowsTab.classList.remove("hidden");
  }
}
function toggleSidebar(open) {
  state.sidebarOpen = open ?? !state.sidebarOpen;
  sidebar.classList.toggle("sidebar--closed", !state.sidebarOpen);
  sidebar.setAttribute("aria-hidden", String(!state.sidebarOpen));
  sidebarCollapsed.classList.toggle("hidden", state.sidebarOpen);
  toggleSidebarBtn.setAttribute("aria-pressed", String(state.sidebarOpen));
  if (state.settings) {
    state.settings.ui.workflowPanel.isOpen = state.sidebarOpen;
    rpc.request.setSettings({ patch: { ui: { workflowPanel: { isOpen: state.sidebarOpen } } } });
  }
}
function openMenu(key, anchor) {
  const items = getMenuItems(key);
  if (!items.length)
    return;
  anchor.setAttribute("aria-expanded", "true");
  menuDropdown.innerHTML = items.map((item, index) => {
    if (item.separator) {
      return `<div class="menu-separator" role="separator"></div>`;
    }
    return `
        <button class="menu-row ${item.disabled ? "disabled" : ""}" data-menu-index="${index}" role="menuitem" ${item.disabled ? 'aria-disabled="true"' : ""}>
          <span>${escapeHtml(item.label)}</span>
          <span class="menu-shortcut" aria-hidden="true">${item.shortcut ?? ""}</span>
        </button>
      `;
  }).join("");
  const rect = anchor.getBoundingClientRect();
  menuDropdown.style.left = `${rect.left}px`;
  menuDropdown.style.top = `${rect.bottom + 4}px`;
  menuDropdown.classList.remove("hidden");
  menuDropdown.setAttribute("aria-hidden", "false");
  const firstItem = menuDropdown.querySelector(".menu-row:not(.disabled)");
  firstItem?.focus();
  menuDropdown.querySelectorAll(".menu-row").forEach((btn) => {
    const index = Number(btn.dataset.menuIndex ?? -1);
    const item = items[index];
    if (!item || item.disabled || !item.action)
      return;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMenu();
      item.action?.();
    });
  });
}
function closeMenu() {
  menuDropdown.classList.add("hidden");
  menuDropdown.setAttribute("aria-hidden", "true");
  menuDropdown.innerHTML = "";
  menuButtons.forEach((btn) => btn.setAttribute("aria-expanded", "false"));
}
function getMenuItems(key) {
  switch (key) {
    case "file":
      return [
        { label: "New Chat Session", shortcut: "⌘N", action: () => newSessionBtn.click() },
        { label: "Open Workspace…", shortcut: "⌘O", action: () => openWorkspaceDialog() },
        { label: "Close Workspace", action: () => closeWorkspace(), disabled: !state.workspaceRoot }
      ];
    case "workflow":
      return [
        { label: "Run Workflow…", shortcut: "⌘R", action: () => openRunDialog() },
        { label: "Show Runs", shortcut: "⌘⇧R", action: () => switchTab("runs") },
        { label: "Approvals", shortcut: "⌘⇧A", action: () => focusNextApproval() },
        { label: "Cancel Current Run", shortcut: "⌘.", action: () => cancelCurrentRun() }
      ];
    case "view":
      return [
        { label: "Toggle Workflow Panel", shortcut: "⌘\\", action: () => toggleSidebar() },
        { label: "Toggle Artifacts Panel", shortcut: "⌘⇧\\", action: () => toggleArtifactsPanel() },
        { separator: true, label: "sep" },
        { label: "Zoom In (Graph)", shortcut: "⌘=", action: () => adjustGraphZoom(0.1) },
        { label: "Zoom Out (Graph)", shortcut: "⌘-", action: () => adjustGraphZoom(-0.1) }
      ];
    case "settings":
      return [
        { label: "Preferences…", shortcut: "⌘,", action: () => void openSettingsDialog() }
      ];
    case "help":
      return [
        { label: "Docs (smithers.sh)", action: () => pushToast("info", "Open smithers.sh in your browser.") }
      ];
    default:
      return [];
  }
}
function handleShortcuts(event) {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta)
    return;
  const key = event.key;
  if (key.toLowerCase() === "n" && !event.shiftKey) {
    event.preventDefault();
    newSessionBtn.click();
    return;
  }
  if (key.toLowerCase() === "o") {
    event.preventDefault();
    openWorkspaceDialog();
    return;
  }
  if (key.toLowerCase() === "r" && !event.shiftKey) {
    event.preventDefault();
    openRunDialog();
    return;
  }
  if (key.toLowerCase() === "r" && event.shiftKey) {
    event.preventDefault();
    switchTab("runs");
    toggleSidebar(true);
    return;
  }
  if (key.toLowerCase() === "a" && event.shiftKey) {
    event.preventDefault();
    focusNextApproval();
    return;
  }
  if (key === "." && !event.shiftKey) {
    event.preventDefault();
    cancelCurrentRun();
    return;
  }
  if (key === "\\" && !event.shiftKey) {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (key === "\\" && event.shiftKey) {
    event.preventDefault();
    toggleArtifactsPanel();
    return;
  }
  if (key === "=" || key === "+" && event.shiftKey) {
    event.preventDefault();
    adjustGraphZoom(0.1);
    return;
  }
  if (key === "-") {
    event.preventDefault();
    adjustGraphZoom(-0.1);
  }
}
function focusNextApproval() {
  const run = state.runs.find((r) => (r.waitingApprovals ?? 0) > 0);
  if (run) {
    focusRun(run.runId);
  } else {
    pushToast("info", "No pending approvals.");
  }
}
function cancelCurrentRun() {
  if (!state.selectedRunId)
    return;
  rpc.request.cancelRun({ runId: state.selectedRunId });
}
function adjustGraphZoom(delta) {
  state.graphZoom = Math.max(0.4, Math.min(2.5, state.graphZoom + delta));
  const canvas = document.querySelector(".graph-canvas");
  if (canvas)
    applyGraphTransform(canvas);
}
function toggleArtifactsPanel() {
  const current = state.settings?.ui.artifactsPanelOpen ?? true;
  const next = !current;
  if (state.settings) {
    state.settings.ui.artifactsPanelOpen = next;
    rpc.request.setSettings({ patch: { ui: { artifactsPanelOpen: next } } });
  }
  document.body.classList.toggle("artifacts-hidden", !next);
}
function closeWorkspace() {
  rpc.request.openWorkspace({ path: "" }).then(() => loadWorkspaceState());
}
function pushToast(level, message) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", level === "error" ? "assertive" : "polite");
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast--hide");
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
function attachGraphHandlers(container, runId) {
  const drawer = container.querySelector("#node-drawer");
  const viewport = container.querySelector(".graph-viewport");
  const canvas = container.querySelector(".graph-canvas");
  if (!drawer || !viewport || !canvas)
    return;
  container.querySelectorAll("[data-graph-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.graphAction;
      if (action === "zoom-in") {
        state.graphZoom = Math.min(2.5, state.graphZoom + 0.1);
      } else if (action === "zoom-out") {
        state.graphZoom = Math.max(0.4, state.graphZoom - 0.1);
      } else if (action === "fit") {
        state.graphZoom = 1;
        state.graphPan = { x: 0, y: 0 };
      }
      applyGraphTransform(canvas);
    });
  });
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startPan = { x: 0, y: 0 };
  viewport.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (target?.closest("[data-node-id]"))
      return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startPan = { ...state.graphPan };
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragging)
      return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    state.graphPan = { x: startPan.x + dx, y: startPan.y + dy };
    applyGraphTransform(canvas);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
  container.querySelectorAll("[data-node-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.getAttribute("data-node-id");
      if (!nodeId)
        return;
      renderNodeDrawer(drawer, runId, nodeId);
    });
  });
}
function applyGraphTransform(canvas) {
  canvas.style.transform = `translate(${state.graphPan.x}px, ${state.graphPan.y}px) scale(${state.graphZoom})`;
}
async function renderNodeDrawer(drawer, runId, nodeId) {
  const detail = state.runDetails.get(runId) ?? await rpc.request.getRun({ runId });
  state.runDetails.set(runId, detail);
  const node = detail.nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    drawer.innerHTML = `<div class="empty">No node details.</div>`;
    return;
  }
  const outputs = await ensureRunOutputs(runId);
  const attempts = await ensureRunAttempts(runId);
  const toolCalls = await ensureRunToolCalls(runId);
  const nodeAttempts = attempts.attempts.filter((a) => a.nodeId === node.nodeId && a.iteration === node.iteration);
  const latestAttempt = nodeAttempts[0];
  let meta = null;
  if (latestAttempt?.metaJson) {
    try {
      meta = JSON.parse(latestAttempt.metaJson);
    } catch {
      meta = null;
    }
  }
  const promptText = meta?.prompt ? String(meta.prompt) : "Not available yet.";
  const outputRows = outputs.tables.flatMap((t) => t.rows.map((row) => ({ table: t.name, row })).filter((entry) => {
    const row = entry.row;
    const iter = typeof row?.iteration === "number" ? row.iteration : 0;
    return row?.nodeId === node.nodeId && iter === node.iteration;
  }));
  const outputText = outputRows.length ? JSON.stringify(outputRows, null, 2) : "No output rows for this node.";
  const nodeToolCalls = toolCalls.toolCalls.filter((call) => call.nodeId === node.nodeId && call.iteration === node.iteration);
  drawer.innerHTML = `
    <div class="node-drawer__header">
      <div>
        <div class="node-drawer__title">${escapeHtml(node.nodeId)}</div>
        <div class="node-drawer__meta">state: ${node.state} • iter ${node.iteration}</div>
      </div>
      <div class="node-drawer__actions">
        <button class="btn btn-ghost" data-copy="prompt">Copy prompt</button>
        <button class="btn btn-ghost" data-copy="output">Copy output</button>
        ${node.state === "waiting-approval" ? `<button class="btn btn-primary" data-approve>Approve</button>` : ""}
        ${node.state === "waiting-approval" ? `<button class="btn btn-danger" data-deny>Deny</button>` : ""}
        <button class="btn btn-ghost" data-ask>Ask agent</button>
      </div>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Prompt</div>
      <pre>${escapeHtml(promptText)}</pre>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Output</div>
      <pre>${escapeHtml(outputText)}</pre>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Tool Calls</div>
      ${nodeToolCalls.length ? nodeToolCalls.map((call) => `
        <div class="tool-call">
          <div class="tool-call__header">
            <span class="mono">${call.toolName}</span>
            <span>${call.status}</span>
          </div>
          <div class="tool-call__meta">attempt ${call.attempt} • ${formatDuration(call.startedAtMs, call.finishedAtMs ?? null)}</div>
          <pre>${escapeHtml(call.inputJson ?? "")}</pre>
          <pre>${escapeHtml(call.outputJson ?? "")}</pre>
        </div>
      `).join("") : `<div class="empty">No tool calls recorded.</div>`}
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Last Error</div>
      <pre>${node.lastError ? escapeHtml(JSON.stringify(node.lastError, null, 2)) : "None"}</pre>
    </div>
  `;
  drawer.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.copy;
      const text = type === "prompt" ? promptText : outputText;
      navigator.clipboard?.writeText(text).catch(() => {});
      pushToast("info", `${type === "prompt" ? "Prompt" : "Output"} copied.`);
    });
  });
  const approveBtn = drawer.querySelector("[data-approve]");
  const denyBtn = drawer.querySelector("[data-deny]");
  approveBtn?.addEventListener("click", async () => {
    await rpc.request.approveNode({ runId, nodeId: node.nodeId, iteration: node.iteration });
    await refreshRuns();
    await focusRun(runId);
  });
  denyBtn?.addEventListener("click", async () => {
    await rpc.request.denyNode({ runId, nodeId: node.nodeId, iteration: node.iteration });
    await refreshRuns();
    await focusRun(runId);
  });
  const askBtn = drawer.querySelector("[data-ask]");
  askBtn?.addEventListener("click", () => {
    askAgentAboutNode(runId, node.nodeId, node.iteration);
  });
}
async function ensureRunOutputs(runId) {
  let data = state.outputs.get(runId);
  if (!data) {
    data = await rpc.request.getRunOutputs({ runId });
    state.outputs.set(runId, data);
  }
  return data;
}
async function ensureRunAttempts(runId) {
  let data = state.attempts.get(runId);
  if (!data) {
    data = await rpc.request.getRunAttempts({ runId });
    state.attempts.set(runId, data);
  }
  return data;
}
async function ensureRunToolCalls(runId) {
  let data = state.toolCalls.get(runId);
  if (!data) {
    data = await rpc.request.getRunToolCalls({ runId });
    state.toolCalls.set(runId, data);
  }
  return data;
}
function formatEvent(event) {
  switch (event.type) {
    case "RunStarted":
      return `Run started`;
    case "RunFinished":
      return `Run finished`;
    case "RunFailed":
      return `Run failed`;
    case "RunCancelled":
      return `Run cancelled`;
    case "NodeStarted":
      return `Node ${event.nodeId} started (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeFinished":
      return `Node ${event.nodeId} finished (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeFailed":
      return `Node ${event.nodeId} failed (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeRetrying":
      return `Node ${event.nodeId} retrying (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeWaitingApproval":
      return `Node ${event.nodeId} waiting approval (iter ${event.iteration})`;
    case "ApprovalRequested":
      return `Approval requested for ${event.nodeId}`;
    case "ApprovalGranted":
      return `Approval granted for ${event.nodeId}`;
    case "ApprovalDenied":
      return `Approval denied for ${event.nodeId}`;
    case "RevertStarted":
      return `Revert started for ${event.nodeId}`;
    case "RevertFinished":
      return `Revert finished for ${event.nodeId} (${event.success ? "ok" : "failed"})`;
    default:
      return event.type;
  }
}
function stateColor(state2) {
  switch (state2) {
    case "in-progress":
      return { bg: "#1a1208", stroke: "#f27638" };
    case "finished":
      return { bg: "#0a1a10", stroke: "#2f7d4a" };
    case "failed":
      return { bg: "#1e0a0a", stroke: "#b11226" };
    case "waiting-approval":
      return { bg: "#1a1508", stroke: "#efb85d" };
    case "cancelled":
    case "skipped":
      return { bg: "#161a1e", stroke: "#6f675a" };
    default:
      return { bg: "#161a1e", stroke: "#4b463c" };
  }
}
function formatTime(ms) {
  const date = new Date(ms);
  return date.toLocaleTimeString();
}
function formatDuration(startMs, endMs) {
  const end = endMs ?? Date.now();
  const delta = Math.max(0, end - startMs);
  const seconds = Math.floor(delta / 1000);
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const parts = [];
  if (hours)
    parts.push(`${hours}h`);
  if (mins % 60 || !hours)
    parts.push(`${mins % 60}m`);
  if (!hours && mins < 5)
    parts.push(`${seconds % 60}s`);
  return parts.join(" ");
}
function shortenPath(path, max = 28) {
  if (path.length <= max)
    return path;
  return `…${path.slice(-max)}`;
}
function truncate(value, max = 120) {
  if (value.length <= max)
    return value;
  return `${value.slice(0, max - 1)}…`;
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function extractText(userMessage) {
  if (typeof userMessage.content === "string") {
    return userMessage.content;
  }
  if (Array.isArray(userMessage.content)) {
    return userMessage.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  return "";
}
function openWorkspaceDialog() {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "workspace-dialog-title");
  overlay.innerHTML = `
    <div class="modal__dialog">
      <h2 class="modal__header" id="workspace-dialog-title">Open Workspace</h2>
      <label class="modal__label" for="workspace-path">Workspace path</label>
      <input class="input" id="workspace-path" value="${state.workspaceRoot ?? ""}" aria-describedby="workspace-help" />
      <span id="workspace-help" class="sr-only">Enter the full path to your workspace directory</span>
      <div class="modal__actions">
        <button class="btn btn-ghost" id="workspace-cancel" aria-label="Cancel and close dialog">Cancel</button>
        <button class="btn btn-ghost" id="workspace-clear" aria-label="Close current workspace">Close Workspace</button>
        <button class="btn btn-primary" id="workspace-open" aria-label="Open the specified workspace">Open</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const pathInput = overlay.querySelector("#workspace-path");
  pathInput?.focus();
  const handleKeydown = (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handleKeydown);
    }
  };
  document.addEventListener("keydown", handleKeydown);
  overlay.querySelector("#workspace-cancel")?.addEventListener("click", () => {
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
  });
  overlay.querySelector("#workspace-clear")?.addEventListener("click", async () => {
    await rpc.request.openWorkspace({ path: "" });
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
    await loadWorkspaceState();
  });
  overlay.querySelector("#workspace-open")?.addEventListener("click", async () => {
    const input = overlay.querySelector("#workspace-path");
    try {
      await rpc.request.openWorkspace({ path: input.value });
      overlay.remove();
      document.removeEventListener("keydown", handleKeydown);
      await loadWorkspaceState();
    } catch (err) {
      pushToast("error", `Failed to open workspace: ${String(err)}`);
    }
  });
}
async function openSettingsDialog() {
  try {
    state.secretStatus = await rpc.request.getSecretStatus({});
  } catch {}
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "settings-dialog-title");
  const isOpen = state.settings?.ui.workflowPanel.isOpen ?? true;
  const width = state.settings?.ui.workflowPanel.width ?? 380;
  const agentSettings = state.settings?.agent ?? {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 1024,
    systemPrompt: ""
  };
  const allowNetwork = state.settings?.smithers?.allowNetwork ?? false;
  const openaiConfigured = state.secretStatus?.openai ?? false;
  const anthropicConfigured = state.secretStatus?.anthropic ?? false;
  overlay.innerHTML = `
    <div class="modal__dialog">
      <h2 class="modal__header" id="settings-dialog-title">Preferences</h2>
      <label class="modal__label" for="settings-panel-open">Workflow panel open</label>
      <select class="select" id="settings-panel-open" aria-label="Workflow panel visibility">
        <option value="true" ${isOpen ? "selected" : ""}>Open</option>
        <option value="false" ${!isOpen ? "selected" : ""}>Closed</option>
      </select>
      <label class="modal__label" for="settings-panel-width">Workflow panel width</label>
      <input class="input" id="settings-panel-width" type="number" value="${width}" aria-label="Workflow panel width in pixels" />
      <div class="modal__section">AI Provider</div>
      <label class="modal__label" for="settings-provider">Provider</label>
      <select class="select" id="settings-provider" aria-label="AI provider">
        <option value="openai" ${agentSettings.provider === "openai" ? "selected" : ""}>OpenAI</option>
        <option value="anthropic" ${agentSettings.provider === "anthropic" ? "selected" : ""}>Anthropic</option>
      </select>
      <label class="modal__label" for="settings-model">Model</label>
      <input class="input" id="settings-model" value="${escapeHtml(agentSettings.model ?? "")}" aria-label="Model name" />
      <label class="modal__label" for="settings-temperature">Temperature</label>
      <input class="input" id="settings-temperature" type="number" step="0.1" value="${agentSettings.temperature ?? 0.2}" aria-label="Temperature" />
      <label class="modal__label" for="settings-max-tokens">Max tokens</label>
      <input class="input" id="settings-max-tokens" type="number" value="${agentSettings.maxTokens ?? 1024}" aria-label="Maximum tokens" />
      <label class="modal__label" for="settings-system-prompt">System prompt</label>
      <textarea class="textarea" id="settings-system-prompt" aria-label="System prompt">${escapeHtml(agentSettings.systemPrompt ?? "")}</textarea>
      <div class="modal__section">API Keys</div>
      <label class="modal__label" for="settings-openai-key">OpenAI API Key</label>
      <input class="input" id="settings-openai-key" type="password" placeholder="${openaiConfigured ? "Configured" : "Not set"}" />
      <button class="btn btn-ghost" id="settings-openai-clear" aria-label="Clear OpenAI API key">Clear OpenAI Key</button>
      <label class="modal__label" for="settings-anthropic-key">Anthropic API Key</label>
      <input class="input" id="settings-anthropic-key" type="password" placeholder="${anthropicConfigured ? "Configured" : "Not set"}" />
      <button class="btn btn-ghost" id="settings-anthropic-clear" aria-label="Clear Anthropic API key">Clear Anthropic Key</button>
      <div class="modal__section">Tools</div>
      <label class="modal__label" for="settings-allow-network">Bash network access</label>
      <select class="select" id="settings-allow-network" aria-label="Allow network access for bash commands">
        <option value="false" ${!allowNetwork ? "selected" : ""}>Blocked</option>
        <option value="true" ${allowNetwork ? "selected" : ""}>Allowed</option>
      </select>
      <div class="modal__actions">
        <button class="btn btn-ghost" id="settings-cancel" aria-label="Cancel changes">Cancel</button>
        <button class="btn btn-primary" id="settings-save" aria-label="Save preferences">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const firstSelect = overlay.querySelector("#settings-panel-open");
  firstSelect?.focus();
  const handleKeydown = (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handleKeydown);
    }
  };
  document.addEventListener("keydown", handleKeydown);
  overlay.querySelector("#settings-cancel")?.addEventListener("click", () => {
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
  });
  overlay.querySelector("#settings-save")?.addEventListener("click", async () => {
    const openValue = overlay.querySelector("#settings-panel-open").value === "true";
    const widthValue = Number(overlay.querySelector("#settings-panel-width").value || "380");
    const provider = overlay.querySelector("#settings-provider").value;
    const modelInput = overlay.querySelector("#settings-model").value.trim();
    const model = modelInput || (provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini");
    const tempValue = Number(overlay.querySelector("#settings-temperature").value || "0.2");
    const temperature = Number.isFinite(tempValue) ? tempValue : 0.2;
    const maxValue = Number(overlay.querySelector("#settings-max-tokens").value || "1024");
    const maxTokens = Number.isFinite(maxValue) ? maxValue : 1024;
    const systemPrompt = overlay.querySelector("#settings-system-prompt").value;
    const allowNetworkValue = overlay.querySelector("#settings-allow-network").value === "true";
    const openaiKey = overlay.querySelector("#settings-openai-key").value.trim();
    const anthropicKey = overlay.querySelector("#settings-anthropic-key").value.trim();
    const settings = await rpc.request.setSettings({
      patch: {
        ui: { workflowPanel: { isOpen: openValue, width: widthValue } },
        agent: { provider, model, temperature, maxTokens, systemPrompt },
        smithers: { allowNetwork: allowNetworkValue }
      }
    });
    if (openaiKey) {
      await rpc.request.setSecret({ key: "openai.apiKey", value: openaiKey });
    }
    if (anthropicKey) {
      await rpc.request.setSecret({ key: "anthropic.apiKey", value: anthropicKey });
    }
    state.secretStatus = await rpc.request.getSecretStatus({});
    applySettings(settings);
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
  });
  overlay.querySelector("#settings-openai-clear")?.addEventListener("click", async () => {
    await rpc.request.clearSecret({ key: "openai.apiKey" });
    state.secretStatus = await rpc.request.getSecretStatus({});
    pushToast("info", "OpenAI API key cleared.");
  });
  overlay.querySelector("#settings-anthropic-clear")?.addEventListener("click", async () => {
    await rpc.request.clearSecret({ key: "anthropic.apiKey" });
    state.secretStatus = await rpc.request.getSecretStatus({});
    pushToast("info", "Anthropic API key cleared.");
  });
}
function openRunDialog(workflow) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "run-dialog-title");
  overlay.innerHTML = `
    <div class="modal__dialog">
      <h2 class="modal__header" id="run-dialog-title">Run Workflow</h2>
      <label class="modal__label" for="workflow-select">Workflow</label>
      <select class="select" id="workflow-select" aria-label="Select workflow to run"></select>
      <label class="modal__label" for="workflow-input">Input (JSON)</label>
      <textarea class="textarea" id="workflow-input" aria-label="Workflow input as JSON" aria-describedby="input-help">{}</textarea>
      <span id="input-help" class="sr-only">Enter the input parameters for the workflow in JSON format</span>
      <label class="modal__label" for="workflow-session">Attach to chat session</label>
      <input class="input" id="workflow-session" value="${state.sessionId ?? ""}" aria-label="Session ID to attach workflow to" />
      <div class="modal__actions">
        <button class="btn btn-ghost" id="modal-cancel" aria-label="Cancel and close dialog">Cancel</button>
        <button class="btn btn-primary" id="modal-run" aria-label="Start the workflow">Run</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const handleKeydown = (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handleKeydown);
    }
  };
  document.addEventListener("keydown", handleKeydown);
  const select = overlay.querySelector("#workflow-select");
  if (!state.workflows.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No workflows found";
    select.appendChild(option);
  } else {
    state.workflows.forEach((wf) => {
      const option = document.createElement("option");
      option.value = wf.path;
      option.textContent = wf.name ?? wf.path;
      select.appendChild(option);
    });
  }
  if (workflow)
    select.value = workflow.path;
  select.focus();
  const cancelBtn = overlay.querySelector("#modal-cancel");
  cancelBtn.addEventListener("click", () => {
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
  });
  const runBtn = overlay.querySelector("#modal-run");
  runBtn.addEventListener("click", async () => {
    if (!select.value) {
      pushToast("warning", "No workflow selected.");
      return;
    }
    const inputArea = overlay.querySelector("#workflow-input");
    const sessionInput = overlay.querySelector("#workflow-session");
    let input = {};
    try {
      input = JSON.parse(inputArea.value || "{}");
    } catch {
      input = {};
    }
    const run = await rpc.request.runWorkflow({
      workflowPath: select.value,
      input,
      attachToSessionId: sessionInput.value || undefined
    });
    overlay.remove();
    document.removeEventListener("keydown", handleKeydown);
    await refreshRuns();
    await focusRun(run.runId);
  });
}
async function askAgentAboutNode(runId, nodeId, iteration) {
  const message = `Please review workflow run ${runId}, node ${nodeId} (iteration ${iteration}).`;
  const sent = await sendMessageToAgent(message);
  if (!sent) {
    await navigator.clipboard?.writeText(message);
    pushToast("info", "Request copied. Paste into chat to ask the agent.");
  }
}
async function sendMessageToAgent(text) {
  const agentAny = state.agent;
  if (!agentAny)
    return false;
  if (typeof agentAny.sendUserMessage === "function") {
    await agentAny.sendUserMessage(text);
    return true;
  }
  if (typeof agentAny.appendUserMessage === "function") {
    await agentAny.appendUserMessage(text);
    return true;
  }
  if (typeof agentAny.send === "function") {
    await agentAny.send(text);
    return true;
  }
  return false;
}
async function approveFromCard(runId, nodeId, iteration) {
  await rpc.request.approveNode({ runId, nodeId, iteration });
  await refreshRuns();
  await focusRun(runId);
}
async function denyFromCard(runId, nodeId, iteration) {
  await rpc.request.denyNode({ runId, nodeId, iteration });
  await refreshRuns();
  await focusRun(runId);
}

// apps/desktop/src/webview/rpc/web.ts
var MESSAGE_NAMES = [
  "agentEvent",
  "chatMessage",
  "workflowEvent",
  "workflowFrame",
  "workspaceState",
  "toast"
];
function createRequestProxy() {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== "string")
        return;
      return async (params) => {
        const res = await fetch("/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: prop, params: params ?? {} })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload?.ok) {
          const message = payload?.error?.message ?? `RPC ${prop} failed`;
          throw new Error(message);
        }
        return payload.result;
      };
    }
  });
}
function createWebRpcClient(handlers) {
  const request = createRequestProxy();
  const eventSource = new EventSource("/events");
  for (const name of MESSAGE_NAMES) {
    eventSource.addEventListener(name, (event) => {
      try {
        const data = JSON.parse(event.data ?? "null");
        const handler = handlers.messages?.[name];
        if (handler) {
          handler(data);
        }
      } catch (err) {
        console.warn("[web rpc] failed to parse event", name, err);
      }
    });
  }
  eventSource.addEventListener("error", () => {});
  return { request };
}

// apps/desktop/src/webview/main.web.ts
startApp(createWebRpcClient);
