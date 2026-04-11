import { extractTextFromJsonValue } from "./extractTextFromJsonValue";

type AgentStdoutTextEmitterOptions = {
  outputFormat?: string;
  onText?: (text: string) => void;
};

type AgentStdoutTextEmitter = {
  push: (chunk: string) => void;
  flush: (finalText?: string) => void;
};

function extractLastAssistantMessage(messages: unknown): unknown | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function extractCliStreamTextChunks(
  parsed: any,
  state: { sawDeltaSinceBoundary: boolean },
): string[] {
  const chunks: string[] = [];

  const emitDelta = (text: string | undefined) => {
    if (!text) return;
    state.sawDeltaSinceBoundary = true;
    chunks.push(text);
  };

  const emitFinal = (text: string | undefined) => {
    if (text && !state.sawDeltaSinceBoundary) {
      chunks.push(text);
    }
    state.sawDeltaSinceBoundary = false;
  };

  const type = typeof parsed?.type === "string" ? parsed.type : "";
  const upperType = type.toUpperCase();

  if (type === "content_block_delta" && parsed?.delta?.type === "text_delta") {
    emitDelta(typeof parsed.delta.text === "string" ? parsed.delta.text : undefined);
  }

  if (type === "message_update") {
    const assistantEvent = parsed?.assistantMessageEvent;
    if (
      assistantEvent?.type === "text_delta" &&
      typeof assistantEvent.delta === "string"
    ) {
      emitDelta(assistantEvent.delta);
    }
  }

  if (/delta/i.test(type) && type !== "content_block_delta" && type !== "message_update") {
    if (typeof parsed?.delta === "string") {
      emitDelta(parsed.delta);
    } else if (typeof parsed?.delta?.text === "string") {
      emitDelta(parsed.delta.text);
    } else if (typeof parsed?.text === "string") {
      emitDelta(parsed.text);
    }
  }

  if (type === "message" && parsed?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.content ?? parsed.message ?? parsed));
  }

  if (upperType === "MESSAGE" && parsed?.role === "assistant") {
    if (parsed?.delta === true && typeof parsed?.content === "string") {
      emitDelta(parsed.content);
    } else {
      emitFinal(extractTextFromJsonValue(parsed.content ?? parsed.message ?? parsed));
    }
  }

  if (parsed?.role === "assistant" && typeof parsed?.content === "string") {
    emitFinal(parsed.content);
  }

  if (type === "assistant" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "result") {
    emitFinal(extractTextFromJsonValue(parsed.result ?? parsed.response ?? parsed.output ?? parsed));
  }

  if (type === "turn_end" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "message_end" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "agent_end") {
    emitFinal(extractTextFromJsonValue(extractLastAssistantMessage(parsed.messages)));
  }

  if (
    type === "message_stop" ||
    type === "turn.completed" ||
    type === "turn_end" ||
    type === "message_end" ||
    type === "agent_end" ||
    type === "result"
  ) {
    state.sawDeltaSinceBoundary = false;
  }

  return chunks;
}

export function createAgentStdoutTextEmitter(
  options: AgentStdoutTextEmitterOptions,
): AgentStdoutTextEmitter {
  const { outputFormat, onText } = options;
  let buffer = "";
  let emittedAnyText = false;
  const state = { sawDeltaSinceBoundary: false };

  const emitText = (text: string | undefined) => {
    if (!onText || !text) return;
    emittedAnyText = true;
    onText(text);
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    for (const chunk of extractCliStreamTextChunks(parsed, state)) {
      emitText(chunk);
    }
  };

  return {
    push(chunk: string) {
      if (!onText || !chunk) return;
      if (!outputFormat || outputFormat === "text") {
        emitText(chunk);
        return;
      }

      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        processLine(line);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush(finalText?: string) {
      if (!onText) return;
      if (outputFormat && outputFormat !== "text" && buffer.trim()) {
        processLine(buffer);
      }
      buffer = "";
      if (!emittedAnyText && finalText) {
        emitText(finalText);
      }
    },
  };
}
