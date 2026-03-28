/** @jsxImportSource smithers */
import { createSmithers, Workflow, Task } from "../../src";
import { z } from "zod";
import { read } from "../../src/tools";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NotesPrompt from "../prompts/fixtures/jsx-ai-release-notes/notes.mdx";

const dbPath = join(
  mkdtempSync(join(tmpdir(), "smithers-jsx-ai-")),
  "db.sqlite",
);

const { smithers, outputs } = createSmithers(
  {
    output: z.object({
      latestVersion: z.string(),
      changeCount: z.number(),
      highlights: z.array(z.string()),
    }),
  },
  { dbPath },
);

const releaseAgent: any = {
  id: "release-agent",
  tools: { read },
  async generate() {
    const text = await read.execute({ path: "tests/fixtures/changelog.md" });
    const versionMatches = [...text.matchAll(/##\s*([0-9.]+)/g)].map(
      (m) => m[1] ?? "",
    );
    const latestVersion = versionMatches[0] ?? "unknown";
    const sections = text.split(/##\s*[0-9.]+/g).slice(1);
    const latestSection = sections[0] ?? "";
    const highlights = latestSection
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.startsWith("- "))
      .map((line: string) => line.replace(/^-\s*/, ""));
    return {
      output: {
        latestVersion,
        changeCount: highlights.length,
        highlights,
      },
    };
  },
};

export default smithers(() => (
  <Workflow name="release-notes">
    <Task id="notes" output={outputs.output} agent={releaseAgent}>
      <NotesPrompt />
    </Task>
  </Workflow>
));
