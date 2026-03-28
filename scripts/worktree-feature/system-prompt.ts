import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMdx } from "../../src/index.ts";

const SMITHERS_ROOT = resolve(new URL("../../", import.meta.url).pathname);
const REPO_ROOT = resolve(new URL("../../", import.meta.url).pathname);
const PROMPTS = resolve(new URL("./prompts", import.meta.url).pathname);

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `[Could not read ${path}]`;
  }
}

// The full PRD from the plan file
const prdContent = readFile(resolve(REPO_ROOT, ".claude/plans/wobbly-marinating-leaf.md"));

// Key framework files for context
const typesTs = readFile(resolve(SMITHERS_ROOT, "src/types.ts"));
const componentsTs = readFile(resolve(SMITHERS_ROOT, "src/components.ts"));
const extractTs = readFile(resolve(SMITHERS_ROOT, "src/dom/extract.ts"));
const schedulerTs = readFile(resolve(SMITHERS_ROOT, "src/engine/scheduler.ts"));
const engineTs = readFile(resolve(SMITHERS_ROOT, "src/engine/index.ts"));
const jjTs = readFile(resolve(SMITHERS_ROOT, "src/vcs/jj.ts"));
const agentsMd = readFile(resolve(SMITHERS_ROOT, "AGENTS.md"));

const smithersContext = `
## AGENTS.md
${agentsMd}

## Key Source Files

### src/types.ts
\`\`\`ts
${typesTs}
\`\`\`

### src/components.ts
\`\`\`ts
${componentsTs}
\`\`\`

### src/dom/extract.ts
\`\`\`ts
${extractTs}
\`\`\`

### src/engine/scheduler.ts
\`\`\`ts
${schedulerTs}
\`\`\`

### src/engine/index.ts (first 100 lines + key sections)
\`\`\`ts
${engineTs.split("\n").slice(0, 100).join("\n")}
// ... (full file available at submodules/smithers/src/engine/index.ts)
\`\`\`

### src/vcs/jj.ts
\`\`\`ts
${jjTs}
\`\`\`
`;

const Prd = () => prdContent;
const SmithersContext = () => smithersContext;

import SystemPromptMdx from "./prompts/system-prompt.mdx";

export const SYSTEM_PROMPT = renderMdx(SystemPromptMdx, {
  components: {
    Prd,
    SmithersContext,
  },
});
