import type { ModelMessage } from "ai";
import { extractTextFromJsonValue } from "./extractTextFromJsonValue";

type PromptParts = {
  prompt: string;
  systemFromMessages?: string;
};

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}

function messagesToPrompt(messages: ModelMessage[]): PromptParts {
  const systemParts: string[] = [];
  const promptParts: string[] = [];
  for (const msg of messages) {
    const text = contentToText((msg as any).content);
    if (!text) continue;
    const role = (msg as any).role;
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    if (role) {
      promptParts.push(`${String(role).toUpperCase()}: ${text}`);
    } else {
      promptParts.push(text);
    }
  }
  return {
    prompt: promptParts.join("\n\n"),
    systemFromMessages: systemParts.length
      ? systemParts.join("\n\n")
      : undefined,
  };
}

export function extractPrompt(options: any): PromptParts {
  if (!options) return { prompt: "" };
  if ("prompt" in options) {
    const promptInput = options.prompt;
    if (typeof promptInput === "string") {
      return { prompt: promptInput };
    }
    if (Array.isArray(promptInput)) {
      return messagesToPrompt(promptInput as ModelMessage[]);
    }
    return { prompt: "" };
  }
  if (Array.isArray(options.messages)) {
    return messagesToPrompt(options.messages as ModelMessage[]);
  }
  return { prompt: "" };
}
