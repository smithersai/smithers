import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { bamlPlugin } from "../src/baml-plugin";
import { runWorkflow } from "../src/index";

setDefaultTimeout(180_000);

const REPO_ROOT = resolve(import.meta.dir, "..");
const REPO_INDEX = resolve(REPO_ROOT, "src/index.ts");
const BAML_CLI = resolve(REPO_ROOT, "node_modules/.bin/baml-cli");
const RUN_LIVE = process.env.SMITHERS_BAML_LIVE_E2E === "1";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);

function writeFile(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function quote(path: string) {
  return JSON.stringify(path);
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-baml-live-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "smithers-baml-live-fixture", type: "module" }, null, 2),
  );

  writeFile(
    join(dir, "baml_src", "generators.baml"),
    [
      "generator target {",
      '  output_type "typescript"',
      '  output_dir "../"',
      '  version "0.220.0"',
      "  default_client_mode async",
      "}",
    ].join("\n"),
  );

  writeFile(
    join(dir, "baml_src", "story.baml"),
    [
      "class Story {",
      "  title string",
      "  content string",
      "}",
      "",
      "function WriteMeAStory(input: string) -> Story {",
      '  client "openai-responses/gpt-5-mini"',
      '  prompt #"',
      "    Write a short whimsical story with a title.",
      "    Keep the content to 2-4 sentences.",
      "",
      "    Topic: {{ input }}",
      "",
      "    {{ ctx.output_format }}",
      '  "#',
      "}",
    ].join("\n"),
  );

  const generate = spawnSync(BAML_CLI, ["generate", "--from", join(dir, "baml_src")], {
    cwd: dir,
    env: process.env,
    encoding: "utf8",
  });

  if (generate.status !== 0) {
    throw new Error(
      `baml generate failed\nstdout:\n${generate.stdout ?? ""}\nstderr:\n${generate.stderr ?? ""}`,
    );
  }

  writeFile(
    join(dir, "baml_client", "smithers", "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        entries: {
          "story.baml": "baml_client/smithers/files/story.baml.ts",
        },
      },
      null,
      2,
    ),
  );

  writeFile(
    join(dir, "baml_client", "smithers", "files", "story.baml.ts"),
    [
      'import React from "react";',
      `import { Task } from ${quote(REPO_INDEX)};`,
      'import { b } from "../../index.ts";',
      'import { z } from "zod";',
      "",
      "export const WriteMeAStoryOutput = z.object({",
      "  title: z.string(),",
      "  content: z.string(),",
      "});",
      "",
      "export function WriteMeAStory(props) {",
      "  const { args, bamlOptions, ...task } = props;",
      "  return React.createElement(",
      "    Task,",
      "    { ...task, output: WriteMeAStoryOutput, outputSchema: WriteMeAStoryOutput },",
      "    async () => await b.WriteMeAStory(args.input, bamlOptions),",
      "  );",
      "}",
    ].join("\n"),
  );

  writeFile(
    join(dir, "workflow.ts"),
    [
      'import React from "react";',
      `import { createSmithers } from ${quote(REPO_INDEX)};`,
      'import { z } from "zod";',
      'import * as Story from "./baml_src/story.baml";',
      "",
      "export const api = createSmithers(",
      "  {",
      "    writeStory: Story.WriteMeAStoryOutput,",
      "    summary: z.object({",
      "      title: z.string(),",
      "      wordCount: z.number().int(),",
      "    }),",
      "  },",
      `  { dbPath: ${quote(join(dir, "workflow.sqlite"))} },`,
      ");",
      "",
      "export const { smithers, outputs, tables, db, Workflow, Task } = api;",
      "",
      "export default smithers((ctx) => {",
      '  const story = ctx.outputMaybe(outputs.writeStory, { nodeId: "write-story" });',
      "",
      "  return React.createElement(",
      "    Workflow,",
      '    { name: "baml-live-e2e" },',
      "    React.createElement(Story.WriteMeAStory, {",
      '      id: "write-story",',
      '      args: { input: ctx.input.topic },',
      "      timeoutMs: 120_000,",
      "    }),",
      "    story",
      "      ? React.createElement(",
      "          Task,",
      '          { id: "summarize-story", output: outputs.summary },',
      "          {",
      "            title: story.title,",
      "            wordCount: story.content.trim().split(/\\s+/).filter(Boolean).length,",
      "          },",
      "        )",
      "      : null,",
      "  );",
      "});",
    ].join("\n"),
  );

  return dir;
}

test.skipIf(!RUN_LIVE || !HAS_OPENAI_KEY)(
  "BAML .baml imports execute end-to-end with a real LLM",
  async () => {
    const dir = createTempProject();
    bamlPlugin({ cwd: dir, generate: false });

    const mod = await import(`${pathToFileURL(join(dir, "workflow.ts")).href}?t=${Date.now()}`);
    const runId = `baml-live-${Date.now()}`;

    const result = await runWorkflow(mod.default, {
      input: {
        topic: "an optimistic otter astronaut",
      },
      runId,
    });

    expect(result.status).toBe("finished");

    const storyRows = await mod.db.select().from(mod.tables.writeStory);
    const summaryRows = await mod.db.select().from(mod.tables.summary);

    expect(storyRows.length).toBe(1);
    expect(summaryRows.length).toBe(1);
    expect(storyRows[0]?.runId).toBe(runId);
    expect(storyRows[0]?.nodeId).toBe("write-story");
    expect(typeof storyRows[0]?.title).toBe("string");
    expect(storyRows[0]?.title.length).toBeGreaterThan(0);
    expect(typeof storyRows[0]?.content).toBe("string");
    expect(storyRows[0]?.content.length).toBeGreaterThan(20);
    expect(summaryRows[0]?.title).toBe(storyRows[0]?.title);
    expect(summaryRows[0]?.wordCount).toBeGreaterThan(5);

    const manifest = JSON.parse(
      readFileSync(join(dir, "baml_client", "smithers", "manifest.json"), "utf8"),
    ) as { entries: Record<string, string> };
    expect(manifest.entries["story.baml"]).toBe("baml_client/smithers/files/story.baml.ts");
  },
);
