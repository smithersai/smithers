#!/usr/bin/env bun
/**
 * Normalize CLI invocations across docs to use `bunx smithers-orchestrator`.
 *
 * - Replaces bare `smithers <subcommand>` with `bunx smithers-orchestrator <subcommand>`
 *   inside fenced bash code blocks only (so prose like "the smithers init command"
 *   stays untouched).
 * - Also strips the "or globally if linked" note in package-configuration.mdx.
 * - Operates on docs/**\/*.mdx and docs/llms-full.txt.
 *
 * Run: bun scripts/normalize-bunx.ts
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DOCS_ROOT = resolve(import.meta.dir, "../docs");

const KNOWN_SUBCOMMANDS = [
  "init",
  "up",
  "tui",
  "ps",
  "logs",
  "events",
  "chat",
  "inspect",
  "node",
  "why",
  "scores",
  "approve",
  "deny",
  "signal",
  "supervise",
  "cancel",
  "down",
  "hijack",
  "workflow",
  "prompt",
  "ticket",
  "graph",
  "diff",
  "replay",
  "reset",
  "travel",
  "timeline",
  "revert",
  "rag",
  "ask",
  "memory",
  "create",
  "run",
  "fork",
  "serve",
  "ui",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".mdx") || name.endsWith(".md") || name === "llms-full.txt") {
      out.push(p);
    }
  }
  return out;
}

function normalizeCodeBlock(body: string): string {
  // Inside a code block body, replace lines like `smithers <sub> ...`
  // with `bunx smithers-orchestrator <sub> ...`. Tolerate leading
  // whitespace and a leading `$ ` shell prompt.
  const sub = KNOWN_SUBCOMMANDS.join("|");
  const re = new RegExp(
    String.raw`(^|\n)([ \t]*)(\$\s*)?smithers(\s+(?:${sub})\b)`,
    "g",
  );
  return body.replace(re, (_m, lead, indent, prompt, tail) => {
    return `${lead}${indent}${prompt ?? ""}bunx smithers-orchestrator${tail}`;
  });
}

function rewriteFile(path: string): { changed: boolean; before: number; after: number } {
  const original = readFileSync(path, "utf8");
  let out = "";
  let i = 0;
  let inCode = false;
  let codeStart = 0;
  let fenceLine = "";

  // Walk line by line; toggle on triple-backtick fences.
  const lines = original.split("\n");
  const buffer: string[] = [];
  let codeBuf: string[] = [];

  for (const line of lines) {
    const fenceMatch = /^(\s*)(```+)(\s*([a-zA-Z0-9_+-]*))?\s*$/.exec(line);
    if (fenceMatch) {
      if (!inCode) {
        inCode = true;
        fenceLine = line;
        codeBuf = [];
      } else {
        // Closing fence. Decide whether to rewrite the body.
        const lang = /^(\s*)```+\s*([a-zA-Z0-9_+-]*)/.exec(fenceLine)?.[2] ?? "";
        const isShell = ["bash", "sh", "shell", "zsh", "console", ""].includes(lang);
        const body = codeBuf.join("\n");
        const rewritten = isShell ? normalizeCodeBlock(body) : body;
        buffer.push(fenceLine);
        if (rewritten.length > 0) buffer.push(rewritten);
        buffer.push(line);
        inCode = false;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
    } else {
      buffer.push(line);
    }
  }
  // If file ended mid-fence (shouldn't happen), flush.
  if (inCode) {
    buffer.push(fenceLine);
    if (codeBuf.length) buffer.push(...codeBuf);
  }

  out = buffer.join("\n");

  // Strip the "or globally if linked" sentence wherever it appears.
  out = out.replace(
    /the\s+`smithers`\s+command is available via\s+`bunx smithers-orchestrator`\s+or globally if linked\./g,
    "the `smithers` command is invoked via `bunx smithers-orchestrator`. Smithers does not need to be installed globally.",
  );

  if (out !== original) {
    writeFileSync(path, out);
    return { changed: true, before: original.length, after: out.length };
  }
  return { changed: false, before: original.length, after: original.length };
}

const files = walk(DOCS_ROOT);
let changedCount = 0;
let totalBefore = 0;
let totalAfter = 0;
for (const f of files) {
  const r = rewriteFile(f);
  totalBefore += r.before;
  totalAfter += r.after;
  if (r.changed) {
    changedCount++;
    console.log(`  ✓ ${f.replace(DOCS_ROOT, "docs")}  (${r.before} → ${r.after})`);
  }
}
console.log(
  `\nUpdated ${changedCount} file(s). Total bytes ${totalBefore} → ${totalAfter} (${totalBefore - totalAfter} saved).`,
);
