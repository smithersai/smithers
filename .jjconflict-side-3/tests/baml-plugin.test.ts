import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { __internal, createBamlPlugin } from "../src/baml-plugin";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-baml-plugin-"));
  tempDirs.push(dir);
  return dir;
}

function canonicalPath(value: string) {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("baml plugin", () => {
  test("rewrites .baml imports to generated Smithers wrapper modules", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "baml_src", "nested"), { recursive: true });
    mkdirSync(join(dir, "baml_client", "smithers", "files"), { recursive: true });

    writeFileSync(join(dir, "baml_src", "nested", "story.baml"), "function Story() -> string");
    writeFileSync(
      join(dir, "baml_client", "smithers", "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "nested/story.baml": "baml_client/smithers/files/story.baml.js",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(dir, "baml_client", "smithers", "files", "story.baml.js"),
      [
        "export const WriteMeAStoryOutput = { kind: 'schema' };",
        "export function WriteMeAStory() {",
        "  return { title: 'Generated', content: 'Story' };",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import * as Story from "./baml_src/nested/story.baml";',
        "export const result = Story.WriteMeAStory();",
        "export const schema = Story.WriteMeAStoryOutput;",
      ].join("\n"),
    );

    const outdir = join(dir, "dist");
    const build = await Bun.build({
      entrypoints: [join(dir, "main.ts")],
      outdir,
      target: "bun",
      format: "esm",
      plugins: [createBamlPlugin({ cwd: dir, generate: false }) as Bun.BunPlugin],
    });

    expect(build.success).toBe(true);

    const builtFile = build.outputs[0]?.path;
    expect(typeof builtFile).toBe("string");
    if (!builtFile) throw new Error("missing build output path");
    const mod = await import(`${pathToFileURL(builtFile).href}?t=${Date.now()}`);
    expect(mod.result).toEqual({ title: "Generated", content: "Story" });
    expect(mod.schema).toEqual({ kind: "schema" });
  });

  test("onStart can run generation before loading the manifest", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "baml_src"), { recursive: true });
    writeFileSync(join(dir, "baml_src", "story.baml"), "function Story() -> string");

    const generatorScript = join(dir, "fake-baml-generator.mjs");
    const argsLog = join(dir, "args.json");
    writeFileSync(
      generatorScript,
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        "const args = process.argv.slice(2);",
        `writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args, null, 2));`,
        `const root = ${JSON.stringify(dir)};`,
        'mkdirSync(join(root, "baml_client", "smithers", "files"), { recursive: true });',
        'writeFileSync(',
        '  join(root, "baml_client", "smithers", "manifest.json"),',
        '  JSON.stringify({ version: 1, entries: { "story.baml": "baml_client/smithers/files/story.baml.js" } }, null, 2),',
        ");",
        'writeFileSync(',
        '  join(root, "baml_client", "smithers", "files", "story.baml.js"),',
        '  "export const generated = 7;\\nexport function StoryTask() { return generated; }\\n",',
        ");",
      ].join("\n"),
    );

    writeFileSync(
      join(dir, "main.ts"),
      [
        'import * as Story from "./baml_src/story.baml";',
        "export const value = Story.StoryTask();",
      ].join("\n"),
    );

    const outdir = join(dir, "generated-dist");
    const build = await Bun.build({
      entrypoints: [join(dir, "main.ts")],
      outdir,
      target: "bun",
      format: "esm",
      plugins: [
        createBamlPlugin({
          cwd: dir,
          generateCommand: [process.execPath, generatorScript],
          noTests: true,
        }) as Bun.BunPlugin,
      ],
    });

    expect(build.success).toBe(true);
    const args = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
    expect(args).toEqual([
      "generate",
      "--from",
      canonicalPath(join(dir, "baml_src")),
      "--no-tests",
    ]);

    const builtFile = build.outputs[0]?.path;
    expect(typeof builtFile).toBe("string");
    if (!builtFile) throw new Error("missing build output path");
    const mod = await import(`${pathToFileURL(builtFile).href}?t=${Date.now()}`);
    expect(mod.value).toBe(7);
  });

  test("manifest key resolution matches paths relative to baml_src", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "baml_src");
    const sourcePath = join(dir, "baml_src", "foo", "bar.baml");
    mkdirSync(join(sourceDir, "foo"), { recursive: true });
    writeFileSync(sourcePath, "function Bar() -> string");
    const options = __internal.resolvePluginOptions({
      cwd: dir,
      from: "baml_src",
      generate: false,
    });

    const candidates = __internal.candidateManifestKeys(sourcePath, options);
    expect(candidates).toContain("foo/bar.baml");
    expect(candidates).toContain("baml_src/foo/bar.baml");
    expect(sourceDir.endsWith("baml_src")).toBe(true);
  });
});
