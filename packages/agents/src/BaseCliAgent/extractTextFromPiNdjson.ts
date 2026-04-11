import { extractTextFromJsonValue } from "./extractTextFromJsonValue";

function extractTextFromJsonPayload(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return extractTextFromJsonValue(parsed);
  } catch {
    // Possibly JSONL
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const chunks: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const text = extractTextFromJsonValue(parsed);
      if (text) chunks.push(text);
    } catch {
      continue;
    }
  }
  return chunks.length ? chunks.join("") : undefined;
}

export function extractTextFromPiNdjson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  let turnEndMessage: any = null;
  let agentEndMessage: any = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed.type === "turn_end" && parsed.message?.role === "assistant") {
        turnEndMessage = parsed.message;
        break;
      }
      if (parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
        for (let j = parsed.messages.length - 1; j >= 0; j--) {
          const msg = parsed.messages[j];
          if (msg?.role === "assistant") {
            agentEndMessage = msg;
            break;
          }
        }
        if (agentEndMessage) break;
      }
    } catch {
      continue;
    }
  }

  const message = turnEndMessage ?? agentEndMessage;
  if (message) {
    const text = extractTextFromJsonValue(message);
    if (text) return text;
  }

  return extractTextFromJsonPayload(raw);
}
