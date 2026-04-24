#!/usr/bin/env bun
/**
 * Generate the llms-*.txt artifacts from the canonical MDX docs.
 *
 *   docs/llms-core.txt           — the everyday context (~30K tokens target)
 *   docs/llms-memory.txt         — opt-in fragment: cross-run memory
 *   docs/llms-openapi.txt        — opt-in fragment: OpenAPI tools
 *   docs/llms-observability.txt  — opt-in fragment: server, gateway, otel
 *   docs/llms-effect.txt         — opt-in fragment: low-level Effect-ts surface
 *   docs/llms.txt                — index pointing at all of the above
 *
 * Each fragment is a concatenation of MDX bodies (frontmatter stripped).
 * Pages are listed in the manifests below. To change the contents of a
 * fragment, edit the manifest — the script is otherwise stateless.
 *
 * Run: bun scripts/generate-llms.ts
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCS = resolve(import.meta.dir, "../docs");

// -----------------------------------------------------------------------------
// Manifests
// -----------------------------------------------------------------------------

const CORE_PAGES = [
  // Hero
  "index.mdx",
  "introduction.mdx",
  "installation.mdx",
  "quickstart.mdx",
  // The two anchor pages
  "tour.mdx",
  "how-it-works.mdx",
  // JSX surface (single page now — installation + quickstart are stubs)
  "jsx/overview.mdx",
  // CLI catalog
  "cli/overview.mdx",
  "cli/quickstart.mdx",
  // Components reference (every component, compressed)
  "components/workflow.mdx",
  "components/task.mdx",
  "components/sequence.mdx",
  "components/parallel.mdx",
  "components/branch.mdx",
  "components/loop.mdx",
  "components/approval.mdx",
  "components/approval-gate.mdx",
  "components/escalation-chain.mdx",
  "components/decision-table.mdx",
  "components/human-task.mdx",
  "components/signal.mdx",
  "components/wait-for-event.mdx",
  "components/timer.mdx",
  "components/saga.mdx",
  "components/try-catch-finally.mdx",
  "components/sandbox.mdx",
  "components/subflow.mdx",
  "components/continue-as-new.mdx",
  "components/super-smithers.mdx",
  "components/aspects.mdx",
  "components/worktree.mdx",
  "components/review-loop.mdx",
  "components/optimizer.mdx",
  "components/content-pipeline.mdx",
  "components/drift-detector.mdx",
  "components/scan-fix-verify.mdx",
  "components/poller.mdx",
  "components/runbook.mdx",
  "components/supervisor.mdx",
  "components/merge-queue.mdx",
  "components/check-suite.mdx",
  "components/classify-and-route.mdx",
  "components/gather-and-synthesize.mdx",
  "components/panel.mdx",
  "components/debate.mdx",
  "components/kanban.mdx",
  // Recipes and reference
  "recipes.mdx",
  "reference/types.mdx",
  "reference/errors.mdx",
  "reference/package-configuration.mdx",
  "reference/vcs-helpers.mdx",
  // Runtime API (small, useful in core). Events moved to its own opt-in
  // fragment because the SmithersEvent union is ~50 variants of pure
  // schema noise for everyday use.
  "runtime/run-workflow.mdx",
  "runtime/render-frame.mdx",
  "runtime/revert.mdx",
  // TUI is a discrete product surface, not a recipe
  "guides/tui.mdx",
];

const MEMORY_PAGES = [
  "concepts/memory.mdx",
  "guides/memory-quickstart.mdx",
];

const OPENAPI_PAGES = [
  "concepts/openapi-tools.mdx",
  "guides/openapi-tools-quickstart.mdx",
];

const OBSERVABILITY_PAGES = [
  "integrations/server.mdx",
  "integrations/serve.mdx",
  "integrations/gateway.mdx",
  "integrations/mcp-server.mdx",
];

const EVENT_PAGES = [
  "runtime/events.mdx",
  "reference/event-types.mdx",
];

const INTEGRATIONS_PAGES = [
  "integrations/integrations.mdx",
  "integrations/cli-agents.mdx",
  "integrations/sdk-agents.mdx",
  "integrations/tools.mdx",
  "integrations/common-tools.mdx",
  "integrations/ecosystem.mdx",
  "integrations/pi-integration.mdx",
];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Frontmatter = { title?: string; description?: string };

function parseFrontmatter(src: string): { fm: Frontmatter; body: string } {
  if (!src.startsWith("---\n")) return { fm: {}, body: src };
  const end = src.indexOf("\n---\n", 4);
  if (end < 0) return { fm: {}, body: src };
  const yaml = src.slice(4, end);
  const body = src.slice(end + 5).replace(/^\n+/, "");
  const fm: Frontmatter = {};
  for (const line of yaml.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    (fm as any)[m[1]] = v;
  }
  return { fm, body };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function renderPage(relPath: string): string {
  const abs = resolve(DOCS, relPath);
  if (!exists(abs)) {
    console.warn(`  · skip (missing): ${relPath}`);
    return "";
  }
  const src = readFileSync(abs, "utf8");
  const { fm, body } = parseFrontmatter(src);
  const title = fm.title ?? relPath.replace(/\.mdx?$/, "");
  const desc = fm.description ? `> ${fm.description}\n\n` : "";
  return `## ${title}\n\n${desc}${body.trimEnd()}\n\n---\n\n`;
}

function renderManifest(name: string, pages: string[], header: string): string {
  let out = `# ${name}\n\n${header}\n\n---\n\n`;
  for (const p of pages) out += renderPage(p);
  // Trim trailing separator
  return out.replace(/\n---\n\n$/, "\n");
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

const HEADERS = {
  core: [
    "> Smithers — durable AI workflow orchestration as a JSX runtime.",
    "> Repo: github.com/smithersai/smithers · Package: smithers-orchestrator (npm)",
    "",
    "This file contains the core Smithers documentation. Read top to bottom for a complete picture of the runtime, JSX surface, CLI, and components.",
    "",
    "Opt-in fragments cover features most users do not need:",
    "  - Memory (cross-run state):       /llms-memory.txt",
    "  - OpenAPI tools:                  /llms-openapi.txt",
    "  - Observability + HTTP server:    /llms-observability.txt",
    "  - Integrations + CLI agents:      /llms-integrations.txt",
    "  - Event types (full union):       /llms-events.txt",
    "",
    "Changelogs are not included; see /docs/changelogs/ on the docs site.",
  ].join("\n"),
  memory: "> Smithers cross-run memory: working memory, message history, semantic recall, processors.",
  openapi: "> Smithers OpenAPI tools: turn an OpenAPI spec into AI SDK tools, with auth, filters, and observability.",
  observability: "> Smithers observability surface: HTTP server, gateway, MCP, OpenTelemetry, metrics.",
  integrations: "> Smithers integrations: agent runtimes (Claude Code, Codex, Gemini, Pi), tool surfaces, ecosystem partners.",
  events: "> Smithers event surface: how to subscribe, the event categories, and the full SmithersEvent discriminated union (~50 variants).",
};

const builds: Array<{ file: string; pages: string[]; header: string; name: string }> = [
  { file: "llms-core.txt", pages: CORE_PAGES, header: HEADERS.core, name: "Smithers" },
  { file: "llms-memory.txt", pages: MEMORY_PAGES, header: HEADERS.memory, name: "Smithers Memory" },
  { file: "llms-openapi.txt", pages: OPENAPI_PAGES, header: HEADERS.openapi, name: "Smithers OpenAPI Tools" },
  { file: "llms-observability.txt", pages: OBSERVABILITY_PAGES, header: HEADERS.observability, name: "Smithers Observability" },
  { file: "llms-integrations.txt", pages: INTEGRATIONS_PAGES, header: HEADERS.integrations, name: "Smithers Integrations" },
  { file: "llms-events.txt", pages: EVENT_PAGES, header: HEADERS.events, name: "Smithers Events" },
];

let totalBytes = 0;
const fragmentBodies: string[] = [];
for (const b of builds) {
  console.log(`\n→ ${b.file}`);
  const content = renderManifest(b.name, b.pages, b.header);
  writeFileSync(resolve(DOCS, b.file), content);
  const bytes = content.length;
  totalBytes += bytes;
  fragmentBodies.push(content);
  console.log(`  ${bytes.toLocaleString()} bytes (~${Math.round(bytes / 4).toLocaleString()} tokens)`);
}

// -----------------------------------------------------------------------------
// llms-full.txt — concatenation of every fragment.
//
// This is the conventional "full file" most consumers fetch from the docs site.
// llms-core.txt is the trimmed everyday version; llms-full.txt is the kitchen
// sink for tools that want a single artifact.
// -----------------------------------------------------------------------------

{
  const fullHeader = [
    "# Smithers — full documentation",
    "",
    "> Durable AI workflow orchestration as a JSX runtime.",
    "> Repo: github.com/smithersai/smithers · Package: smithers-orchestrator (npm)",
    "",
    "This is the complete Smithers documentation in one file. It is the concatenation of every fragment listed in /llms.txt.",
    "",
    "If you only need the everyday surface (runtime, JSX, CLI, components, recipes, types, errors) read /llms-core.txt instead — it is roughly half the size and skips the opt-in fragments below.",
    "",
    "Fragments included in this file:",
    "  1. /llms-core.txt           — core runtime, JSX, CLI, components, recipes, types",
    "  2. /llms-memory.txt         — cross-run memory",
    "  3. /llms-openapi.txt        — OpenAPI tool generation",
    "  4. /llms-observability.txt  — HTTP server, gateway, MCP, OpenTelemetry",
    "  5. /llms-effect.txt         — low-level Effect-ts integration",
    "  6. /llms-integrations.txt   — agent runtimes, IDE, CI, ecosystem",
    "",
    "Changelogs are not included; see /docs/changelogs/ on the docs site.",
    "",
    "===============================================================================",
    "",
  ].join("\n");
  const fullContent = fullHeader + fragmentBodies.join("\n\n===============================================================================\n\n");
  writeFileSync(resolve(DOCS, "llms-full.txt"), fullContent);
  const bytes = fullContent.length;
  console.log(`\n→ llms-full.txt (full concat)`);
  console.log(`  ${bytes.toLocaleString()} bytes (~${Math.round(bytes / 4).toLocaleString()} tokens)`);
}

// -----------------------------------------------------------------------------
// llms.txt index
// -----------------------------------------------------------------------------

const indexContent = `# Smithers

Durable AI workflow orchestration as a JSX runtime.

## Documentation

- [Core docs](/llms-core.txt) — runtime, JSX surface, CLI, components, recipes, types, errors
- [Memory fragment](/llms-memory.txt) — cross-run memory: facts, history, recall
- [OpenAPI tools fragment](/llms-openapi.txt) — generate AI SDK tools from OpenAPI specs
- [Observability fragment](/llms-observability.txt) — HTTP server, gateway, MCP, OpenTelemetry
- [Integrations fragment](/llms-integrations.txt) — agent runtimes, tools, ecosystem
- [Events fragment](/llms-events.txt) — full SmithersEvent discriminated union

## Pointers

- npm: smithers-orchestrator
- github: github.com/smithersai/smithers
- changelogs: docs/changelogs/ on the site (not duplicated in llms files)
`;

writeFileSync(resolve(DOCS, "llms.txt"), indexContent);
console.log(`\n→ llms.txt (index)`);
console.log(`  ${indexContent.length.toLocaleString()} bytes`);

console.log(`\nTotal: ${totalBytes.toLocaleString()} bytes (~${Math.round(totalBytes / 4).toLocaleString()} tokens) across all fragments.`);
