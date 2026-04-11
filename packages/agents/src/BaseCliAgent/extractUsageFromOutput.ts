import type { CliUsageInfo } from "./CliUsageInfo";

/**
 * Extract token usage from raw CLI stdout. Each CLI harness reports usage
 * differently:
 *  - Claude Code stream-json: `message_start` has input, `message_delta` has output
 *  - Codex --json: `turn.completed` has usage
 *  - Gemini json: top-level `stats.models` with per-model tokens
 *  - Generic: any NDJSON line with a `usage` object
 */
export function extractUsageFromOutput(raw: string): CliUsageInfo | undefined {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const usage: CliUsageInfo = {};
  let found = false;

  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;

    // Claude Code stream-json: message_start contains input token counts
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (u.input_tokens ?? 0);
      if (u.cache_read_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cache_creation_input_tokens;
      }
      found = true;
      continue;
    }

    // Claude Code stream-json: message_delta has output token count
    if (parsed.type === "message_delta" && parsed.usage) {
      if (parsed.usage.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + parsed.usage.output_tokens;
      }
      found = true;
      continue;
    }

    // Codex --json: turn.completed event
    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens) usage.inputTokens = (usage.inputTokens ?? 0) + u.input_tokens;
      if (u.output_tokens) usage.outputTokens = (usage.outputTokens ?? 0) + u.output_tokens;
      if (u.cached_input_tokens) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cached_input_tokens;
      found = true;
      continue;
    }

    // Generic: any event with a top-level "usage" containing token fields
    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage;
      const inTok = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0;
      const outTok = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
      if (inTok > 0 || outTok > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + inTok;
        usage.outputTokens = (usage.outputTokens ?? 0) + outTok;
        if (u.cache_read_input_tokens || u.cacheReadTokens || u.cached_input_tokens) {
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) +
            (u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cached_input_tokens ?? 0);
        }
        if (u.reasoning_tokens ?? u.reasoningTokens) {
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) +
            (u.reasoning_tokens ?? u.reasoningTokens ?? 0);
        }
        found = true;
        continue;
      }
    }
  }

  // Gemini JSON output: single result object with stats.models map
  if (!found) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed?.stats?.models && typeof parsed.stats.models === "object") {
        for (const data of Object.values(parsed.stats.models as Record<string, any>)) {
          if (data?.tokens) {
            usage.inputTokens = (usage.inputTokens ?? 0) + (data.tokens.input ?? data.tokens.prompt ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (data.tokens.output ?? 0);
            found = true;
          }
        }
      }
    } catch { /* not single JSON */ }
  }

  return found ? usage : undefined;
}
