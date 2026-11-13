import { MAX_JSON_DEPTH } from "./formatJsonSafe";

/**
 * Pretty-print possibly-partial streaming JSON without changing its tokens.
 * Complete JSON gets two-space indentation; numbers, string escapes, duplicate
 * keys and key order stay as written. Invalid fragments and deeply nested
 * complete values stay verbatim, never repaired or re-quoted.
 */
export function formatPartialJson(text: string): { text: string; complete: boolean } {
  try {
    // Validate only. Printing the parsed value would round numbers and drop duplicate keys.
    JSON.parse(text);
  } catch {
    return { text, complete: false };
  }

  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[^\s{}\[\],:]+|[{}\[\],:]/g)!;
  const parts: string[] = [];
  let depth = 0;
  const newline = () => parts.push("\n", "  ".repeat(depth));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    switch (token) {
      case "{":
      case "[":
        // Bound indentation growth on untrusted model text without truncating it.
        if (depth > MAX_JSON_DEPTH) return { text, complete: true };
        depth += 1;
        parts.push(token);
        if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") newline();
        break;
      case "}":
      case "]":
        depth -= 1;
        if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") newline();
        parts.push(token);
        break;
      case ",":
        parts.push(token);
        newline();
        break;
      case ":":
        parts.push(": ");
        break;
      default:
        parts.push(token);
    }
  }

  return { text: parts.join(""), complete: true };
}
