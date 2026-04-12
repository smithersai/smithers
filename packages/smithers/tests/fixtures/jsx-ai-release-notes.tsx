/** @jsxImportSource smithers */
import { createSmithers, Task, Workflow } from "smithers";
import { z } from "zod";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const CHANGELOG = `# Changelog

## 1.2.0
- Add caching for workflow runs
- Fix resume input handling

## 1.1.0
- Add CLI status and frames commands
`;

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
  async generate() {
    const versionMatches = [...CHANGELOG.matchAll(/##\s*([0-9.]+)/g)].map(
      (match) => match[1] ?? "",
    );
    const latestVersion = versionMatches[0] ?? "unknown";
    const sections = CHANGELOG.split(/##\s*[0-9.]+/g).slice(1);
    const latestSection = sections[0] ?? "";
    const highlights = latestSection
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.replace(/^-\s*/, ""));
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
      Summarize recent changes for release notes.
    </Task>
  </Workflow>
));
