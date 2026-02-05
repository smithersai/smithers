/**
 * ChatPanel - Plain JS chat UI component (no LitElement)
 * Uses standard DOM APIs for maximum compatibility with WKWebView
 */

import type { ChatAgent, ChatAgentState } from "./ChatAgent.js";
import type { Message, AssistantMessage, TextContent, ThinkingContent, ToolCall, WorkflowCardMessage } from "./types.js";

export class ChatPanel extends HTMLElement {
  private agent?: ChatAgent;
  private unsubscribe?: () => void;
  private messages: Message[] = [];
  private streamingMessage: AssistantMessage | null = null;
  private isStreaming = false;
  private inputValue = "";
  private inputAreaEl!: HTMLDivElement;

  private messagesEl!: HTMLDivElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this.render();
    this.setupEventListeners();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
  }

  setAgent(agent: ChatAgent): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.agent = agent;
    this.unsubscribe = agent.subscribe((state: ChatAgentState) => {
      this.messages = state.messages;
      this.streamingMessage = state.streamingMessage;
      this.isStreaming = state.isStreaming;
      this.updateMessages();
      this.updateInputState();
    });
  }

  private render(): void {
    if (!this.shadowRoot) return;

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

    this.messagesEl = this.shadowRoot.querySelector(".messages") as HTMLDivElement;
    this.inputAreaEl = this.shadowRoot.querySelector(".input-area") as HTMLDivElement;
    this.textareaEl = this.shadowRoot.querySelector("textarea") as HTMLTextAreaElement;
    this.sendBtnEl = this.shadowRoot.querySelector("button") as HTMLButtonElement;
  }

  private setupEventListeners(): void {
    this.textareaEl.addEventListener("input", (e) => {
      const textarea = e.target as HTMLTextAreaElement;
      this.inputValue = textarea.value;
      // Auto-resize
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
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLElement>("[data-workflow-action]");
      if (!button) return;
      const action = button.dataset.workflowAction;
      const runId = button.dataset.runId;
      if (!action || !runId) return;
      const nodeId = button.dataset.nodeId;
      const iteration = button.dataset.iteration ? Number(button.dataset.iteration) : undefined;
      this.dispatchEvent(
        new CustomEvent("workflow-card-action", {
          detail: { action, runId, nodeId, iteration },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  private handleSend(): void {
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

  private updateInputState(): void {
    this.textareaEl.disabled = this.isStreaming;
    this.sendBtnEl.disabled = !this.inputValue.trim() || this.isStreaming;
    this.sendBtnEl.textContent = this.isStreaming ? "Stop" : "Send";

    if (this.isStreaming) {
      this.sendBtnEl.onclick = () => this.agent?.abort();
    } else {
      this.sendBtnEl.onclick = () => this.handleSend();
    }
  }

  private updateMessages(): void {
    const allMessages = this.streamingMessage
      ? [...this.messages, this.streamingMessage]
      : this.messages;

    this.messagesEl.innerHTML = allMessages
      .map((msg, idx) => {
        const isStreaming = msg === this.streamingMessage;
        const errorClass = msg.role === "assistant" && (msg as AssistantMessage).stopReason === "error" ? " message--error" : "";
        return `
          <div class="message message--${msg.role}${errorClass}">
            ${this.renderMessageContent(msg)}
            ${isStreaming ? '<span class="streaming-indicator"></span>' : ""}
          </div>
        `;
      })
      .join("");

    // Scroll to bottom
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    // Hide input area until the agent is attached to avoid sending into a dead transport.
    const hasAgent = Boolean(this.agent);
    if (this.inputAreaEl) {
      this.inputAreaEl.style.display = hasAgent ? "flex" : "none";
    }
    this.textareaEl.disabled = !hasAgent || this.isStreaming;
    this.sendBtnEl.disabled = !hasAgent || !this.inputValue.trim() || this.isStreaming;
  }

  private renderMessageContent(message: Message): string {
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") {
        return `<div>${this.escapeHtml(content)}</div>`;
      }
      return content.map((c) => {
        if (c.type === "text") return `<div>${this.escapeHtml(c.text)}</div>`;
        if (c.type === "image") return `<img src="data:${c.mimeType};base64,${c.data}" style="max-width: 100%; border-radius: 0.375rem;" />`;
        return "";
      }).join("");
    }

    if (message.role === "assistant") {
      return message.content.map((c) => {
        if (c.type === "text") return `<div>${this.renderText((c as TextContent).text)}</div>`;
        if (c.type === "thinking") return `<div class="message__thinking">${this.escapeHtml((c as ThinkingContent).thinking)}</div>`;
        if (c.type === "toolCall") {
          const tc = c as ToolCall;
          return `<div class="message__tool-call">→ ${this.escapeHtml(tc.name)}(${this.escapeHtml(JSON.stringify(tc.arguments))})</div>`;
        }
        return "";
      }).join("");
    }

    if (message.role === "toolResult") {
      const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      const truncated = text.slice(0, 200) + (text.length > 200 ? "..." : "");
      return `<div><strong>${this.escapeHtml(message.toolName)}:</strong> ${this.escapeHtml(truncated)}</div>`;
    }

    if ((message as WorkflowCardMessage).role === "workflow") {
      const card = message as WorkflowCardMessage;
      const approvals = card.approvals ?? [];
      const approvalRows = approvals
        .map(
          (approval) => `
          <div class="workflow-card__approval">
            Approval needed: ${this.escapeHtml(approval.nodeId)}
            <div class="workflow-card__actions">
              <button class="primary" data-workflow-action="approve" data-run-id="${this.escapeHtml(
                card.runId,
              )}" data-node-id="${this.escapeHtml(approval.nodeId)}" data-iteration="${approval.iteration ?? 0}">Approve</button>
              <button class="danger" data-workflow-action="deny" data-run-id="${this.escapeHtml(
                card.runId,
              )}" data-node-id="${this.escapeHtml(approval.nodeId)}" data-iteration="${approval.iteration ?? 0}">Deny</button>
            </div>
          </div>
        `,
        )
        .join("");

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

  private renderText(text: string): string {
    // Simple markdown-like rendering for code blocks
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    let result = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

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

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

// Register the custom element
customElements.define("chat-panel", ChatPanel);

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel": ChatPanel;
  }
}
