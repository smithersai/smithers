/**
 * The migration pack inputs, checked against the real registry and the real
 * migration detector.
 *
 * These files are data for the `migrate-smithers-v1` flow and the init pack.
 * Data that nothing runs
 * rots silently, so this suite runs the registry over the prompt bodies and the
 * detector over the fixture, both through their production entry points.
 *
 * Run: node --test flows/pack.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Capability from "@smthrs/capability/Capability";
import * as Detect from "@smthrs/migrate/Detect";
import * as Discovery from "@smthrs/registry/Discovery";
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow";

const flowsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(flowsRoot);
const cli = join(repoRoot, "packages/smithers/bin/smithers.mjs");
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(platform)));

/**
 * The prompt bodies under `flows/`, by their path-derived flow name: the ten
 * authoring bodies the migration composes, the repository flows the
 * smithers.sh tape runs, and the `checks/*` bodies that pin a command for
 * `coding/CommandCheck`.
 */
const EXPECTED_FLOWS = [
  "checks/bundle",
  "checks/bundle-bun",
  "checks/native",
  "checks/native-bun",
  "checks/policy",
  "checks/runtime",
  "create-flow/clarify",
  "create-flow/design",
  "create-flow/document",
  "create-flow/fix",
  "create-flow/provision",
  "create-flow/scaffold",
  "create-skill/clarify",
  "create-skill/design",
  "create-skill/document",
  "create-skill/scaffold",
  "issue-triage",
  "lint",
  "pr-triage",
  "release-notes",
  "review",
];

const FIXTURE = "migrate-smithers-v1/test/fixtures/smithers-0x-hello";

/** The warning the registry attaches to every body that delegates to a flow. */
const DELEGATED = "unprojectable_authority: Delegated flow authority cannot be projected statically; the flow receives every capability";

/** Whether a body's frontmatter names `flows:` it delegates to. */
const delegates = (text) => /^---\n[\s\S]*?^flows:/m.test(text);

/**
 * The capabilities a body declares. The registry replaces a delegating body's
 * list with the conservative wildcard, so read that list from its frontmatter.
 */
const declaredCapabilities = (text, descriptor) => {
  if (!delegates(text)) return descriptor.capabilities;
  const line = /^capabilities: (\[.*\])$/m.exec(text);
  assert.ok(line, "a delegating body declares its capabilities as a JSON array");
  return JSON.parse(line[1]);
};

/** Every `flow.mdx` under `flows/`, as repository-relative POSIX paths. */
function markdownFlows(directory = flowsRoot) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...markdownFlows(full));
    } else if (entry.name === "flow.mdx") {
      found.push(full);
    }
  }
  return found;
}

describe("the staged prompt bodies", () => {
  const files = markdownFlows();

  it("are the authoring bodies and the repository flows", () => {
    assert.deepEqual(
      files.map((file) => relative(flowsRoot, dirname(file)).split("\\").join("/")).sort(),
      EXPECTED_FLOWS,
    );
  });

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} loads through MarkdownFlow with no warnings`, () => {
      const text = readFileSync(file, "utf8");
      const result = MarkdownFlow.fromMarkdown({
        text,
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      });

      assert.deepEqual(
        result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
        delegates(text) ? [DELEGATED] : [],
      );
      assert.ok(Option.isSome(result.descriptor), `${name} produced no descriptor`);

      const descriptor = result.descriptor.value;
      assert.equal(descriptor.name, name);
      assert.ok(descriptor.description.length > 0);
      assert.ok(
        [...descriptor.description].length <= 1024,
        "a description over 1024 characters is refused by the Agent Skills limit",
      );
      assert.equal(descriptor.input._tag, "MarkdownArgs");
      assert.equal(descriptor.output._tag, "MarkdownOutput");
    });

    it(`${name} renders a prompt that carries its body and the caller's arguments`, () => {
      const body = MarkdownFlow.loadBody(readFileSync(file, "utf8"), dirname(file));
      const rendered = MarkdownFlow.renderPrompt(body, { args: "THE-ARGUMENTS" });

      assert.ok(rendered.startsWith(body.text.slice(0, 40)), "the body must lead the prompt");
      assert.ok(rendered.includes("THE-ARGUMENTS"), "the caller's arguments must be appended");
      assert.ok(!rendered.includes("---\ndescription:"), "frontmatter must not reach the model");
    });

    it(`${name} states the 1.0 authoring model, never the 0.x one`, () => {
      const text = readFileSync(file, "utf8");
      for (const removed of [
        "createSmithers",
        "<Task",
        "jsxImportSource",
        "gateway-react",
        "gateway-ui",
        "bunx smthrs",
        "ask-human",
        "smithers ui ",
        "props.schema",
      ]) {
        assert.ok(!text.includes(removed), `${name} still mentions "${removed}"`);
      }
    });
  }
});

describe("the capabilities the staged prompt bodies declare", () => {
  const files = markdownFlows();

  /** A command line each `proc:spawn` grant has to permit to be worth anything. */
  const COMMANDS = ["pnpm test", "git push origin main", "node scripts/check-legacy-absent.mjs"];

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} declares capabilities the permission kernel can parse`, () => {
      const text = readFileSync(file, "utf8");
      const declared = declaredCapabilities(text, MarkdownFlow.fromMarkdown({
        text,
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      }).descriptor.value);

      for (const literal of declared) {
        // The registry stores whatever string the frontmatter carries, so a
        // typo inside a resource is silently accepted here and only refused
        // later, at the cell boundary, when the action asks for a capability
        // nobody granted. Parse each literal the way the kernel does.
        const parsed = Capability.parse(literal);
        assert.ok(Option.isSome(parsed), `${literal} is not a capability the kernel can parse`);
        assert.equal(
          parsed.value.resource,
          parsed.value.resource.trim(),
          `${literal} has whitespace around its resource, which no request can match`,
        );
      }
    });

    it(`${name} grants a real command line where it asks to spawn one`, () => {
      const text = readFileSync(file, "utf8");
      const declared = declaredCapabilities(text, MarkdownFlow.fromMarkdown({
        text,
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      }).descriptor.value);

      const spawns = declared.filter((literal) => literal.startsWith("proc:spawn"));
      if (spawns.length === 0) return;

      const permits = (literal, command) => {
        const parsed = Capability.parse(literal);
        return Option.isSome(parsed) &&
          Capability.matches(
            new Capability.CapabilityPattern({
              action: parsed.value.action,
              resource: parsed.value.resource,
            }),
            Capability.make("proc:spawn", command),
          );
      };

      for (const literal of spawns) {
        const resource = literal.slice("proc:spawn:".length);
        if (resource === "*") {
          // The open grant: the command lines a real body asks for.
          for (const command of COMMANDS) {
            assert.ok(permits(literal, command), `${name} declares ${literal} but it does not permit \`${command}\``);
          }
          continue;
        }
        // A named grant. `proc:spawn:git` matches only the bare word `git`, so a
        // body that runs `git diff` is refused at its first call; the grant has
        // to read `proc:spawn:git *`. Check that the program it names runs with
        // an argument.
        const program = resource.replace(/\s*\*+$/, "");
        assert.ok(
          permits(literal, `${program} --version`),
          `${name} declares ${literal}, which permits only the bare \`${program}\`; write \`proc:spawn:${program} *\``,
        );
      }
    });
  }
});

describe("the binary this lane's suites spawn", () => {
  it("is this working tree's source, not a build sitting beside it", () => {
    // `packages/smithers/bin/smithers.mjs` prefers `dist/esm/bin.js` and falls back
    // to `src/bin.ts`, which is right for a published install and wrong for a
    // suite that asks what the source does. A stale `dist/` from an earlier
    // commit answered last build's behaviour to every real-CLI assertion in
    // this lane: the skills install, the hook spawns, and the fixture notices
    // were all green over code the tree no longer had.
    const built = join(repoRoot, "packages/smithers/dist/esm/bin.js");
    assert.ok(
      !existsSync(built),
      `${relative(repoRoot, built)} exists, so every spawn in this lane runs that build instead of ` +
        "packages/smithers/src. Remove packages/smithers/dist before running these suites, or rebuild it from " +
        "the current source if something else needs it.",
    );
  });
});

describe("the CLI the staged prompt bodies teach", () => {
  const files = markdownFlows();

  /**
   * `smthrs <verb> --help`, once per verb path.
   *
   * These bodies are shipped instructions: an agent reads one and runs the
   * command it names. `effect/unstable/cli` answers an undeclared flag with
   * exit 2 and a usage dump, so a prompt that teaches a flag the parser does
   * not have hands the operator a failure instead of an install line. The
   * parser's own listing is the authority, read from the binary in this tree.
   */
  const listings = new Map();
  const help = (path) => {
    if (!listings.has(path)) {
      listings.set(
        path,
        spawnSync(process.execPath, [cli, ...path.split(" "), "--help"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 180_000,
        }),
      );
    }
    return listings.get(path);
  };

  /** Every `smthrs ...` or legacy `smithers ...` invocation in code spans or fences. */
  const invocations = (text) =>
    [...text.matchAll(/`(?:smthrs|smithers) ([^`\n]+)`|^\s*(?:smthrs|smithers) ([^\n]+)$/gm)]
      .map((match) => (match[1] ?? match[2]).trim())
      .filter((argv) => argv.length > 0);

  /** The verb path of one invocation: its leading bare words, at most two. */
  const verbPath = (argv) => {
    const words = [];
    for (const token of argv.split(/\s+/)) {
      if (!/^[a-z][a-z-]*$/.test(token) || words.length === 2) break;
      words.push(token);
    }
    return words.join(" ");
  };

  const longFlags = (text) => [...text.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]);

  const validatePrompt = (text, name) => {
    const named = invocations(text);
    if (/\b(?:smthrs|smithers)\s+[a-z]/.test(text)) {
      assert.ok(named.length > 0, `${name} teaches CLI commands but none reached validation`);
    }
    const paths = new Set();

    for (const argv of named) {
      const path = verbPath(argv);
      assert.ok(path.length > 0, `\`smthrs ${argv}\` names no verb`);
      const listing = help(path);
      assert.equal(listing.status, 0, `\`smthrs ${path}\` is not a command: ${listing.stderr}`);
      // An unknown verb with --help can print root help and still exit zero.
      const usage = /(?:^Usage:|^USAGE)\s+([^\n]+)/m.exec(listing.stdout)?.[1];
      assert.ok(
        usage === `smthrs ${path}` || usage?.startsWith(`smthrs ${path} `),
        `\`smthrs ${path}\` is not a command: ${listing.stdout}`,
      );
      paths.add(path);
      for (const flag of longFlags(argv)) {
        assert.ok(
          listing.stdout.includes(flag),
          `\`smthrs ${path}\` does not declare ${flag}, which ${name} tells the operator to run; ` +
            "effect/unstable/cli exits 2 on an undeclared flag",
        );
      }
    }

    // A flag named on its own, away from its command, is the same defect
    // wearing a different shape: some command in the body has to declare it.
    const attached = new Set(named.flatMap((argv) => longFlags(argv)));
    for (const [, flag] of text.matchAll(/`(--[a-z][a-z-]+)(?:[ =][^`\n]*)?`/g)) {
      if (attached.has(flag)) continue;
      const declaring = [...paths].find((path) => help(path).stdout.includes(flag));
      assert.ok(
        declaring !== undefined,
        `${name} names ${flag}, and no command it names declares it: ${[...paths].join(", ")}`,
      );
    }
  };

  it("extracts current and legacy commands from inline spans and fences", () => {
    const prompt = [
      "Run `smthrs ls` and `smithers doctor`.",
      "```sh",
      "  smthrs logs <run-id> --follow",
      "  smithers plan <flow>",
      "```",
    ].join("\n");
    assert.deepEqual(invocations(prompt), ["ls", "doctor", "logs <run-id> --follow", "plan <flow>"]);
  });

  it("rejects a fixture prompt teaching an invalid smthrs verb and flag", () => {
    for (const argv of ["definitely-invalid-verb", "definitely-invalid-verb --definitely-invalid-flag"]) {
      assert.throws(
        () => validatePrompt(`Run \`smthrs ${argv}\`.`, "invalid verb fixture"),
        /smthrs definitely-invalid-verb.*is not a command/,
      );
    }
  });

  it("rejects a fixture prompt teaching an invalid flag on a valid smthrs command", () => {
    assert.throws(
      () => validatePrompt("```sh\nsmthrs ls --definitely-invalid-flag\n```", "invalid flag fixture"),
      /smthrs ls.*does not declare --definitely-invalid-flag/,
    );
  });

  it("rejects a command-teaching prompt with no extracted invocations", () => {
    assert.throws(
      () => validatePrompt("Run smthrs ls to list flows.", "unformatted command fixture"),
      /teaches CLI commands but none reached validation/,
    );
  });

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} names only commands and flags this CLI declares`, () => {
      validatePrompt(readFileSync(file, "utf8"), name);
    });
  }
});

/** The projection `//:factoryProjection` writes from .smithers/FACTORY.ts over this directory. */
const projectionRoot = join(repoRoot, ".smithers");

describe("the flow catalog", () => {
  /**
   * The `flows` rows of `.smithers/factory.json` are generated by
   * `//:factoryProjection` from this directory and the `Smithers.Flow`
   * declarations in `.smithers/FACTORY.ts`; the build's `ci` verb reds on
   * drift. This suite asserts the join itself: the catalog names exactly the
   * discovered set, and every featured row carries the one-line summary the
   * app shows under the id.
   */
  const catalog = JSON.parse(readFileSync(join(projectionRoot, "factory.json"), "utf8"));

  it("names exactly the flows discovery finds here", async () => {
    const scan = await run(
      Effect.gen(function* () {
        const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path);
        return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" });
      }),
    );
    assert.deepEqual(
      catalog.flows.map((row) => row.id).sort(),
      [...scan.entries].map((entry) => entry.name).sort(),
    );
    for (const row of catalog.flows) {
      const entry = scan.entries.find((candidate) => candidate.name === row.id);
      assert.equal(row.description, entry.description, `${row.id} carries discovery's description`);
      assert.equal(row.path, relative(repoRoot, entry.body.path).split("\\").join("/"));
    }
  });

  it("features the five repository flows first, each with a one-line summary", () => {
    const featured = catalog.flows.filter((row) => row.featured);
    assert.deepEqual(
      featured.map((row) => row.id),
      ["review", "lint", "pr-triage", "issue-triage", "release-notes"],
    );
    assert.deepEqual(catalog.flows.slice(0, featured.length), featured, "featured rows lead the catalog");
    for (const row of featured) {
      assert.equal(typeof row.summary, "string", `${row.id} has a summary`);
      assert.ok(row.summary.length > 0 && !/[\r\n]/.test(row.summary), `${row.id} summary is one line`);
      assert.ok(!/[\u2013\u2014]/.test(row.summary), `${row.id} summary has no em or en dash`);
    }
    for (const row of catalog.flows.slice(featured.length)) {
      assert.equal(row.featured, false);
    }
  });
});

describe("the dispatcher table", () => {
  /**
   * The `on` rows of `.smithers/factory.json` are the day-one Dispatcher
   * table the factory declares (design 2026-09-07 §7): each names the event,
   * the flow or flows it starts, and the sentence the card shows. Rows are
   * declared, never live registrations.
   */
  const projection = JSON.parse(readFileSync(join(projectionRoot, "factory.json"), "utf8"));

  it("declares the day-one rows with a sentence each and the ours policy", () => {
    assert.ok(Array.isArray(projection.on) && projection.on.length > 0, "the factory declares rules");
    for (const rule of projection.on) {
      assert.equal(typeof rule.event, "string");
      assert.ok(typeof rule.flow === "string" || (Array.isArray(rule.flow) && rule.flow.length > 0));
      assert.equal(typeof rule.description, "string", `${rule.event} carries its sentence`);
      assert.ok(!/[\u2013\u2014]/.test(rule.description), `${rule.event} sentence has no em or en dash`);
      assert.ok(!/workflow/i.test(rule.description), `${rule.event} sentence never says workflow`);
    }
    assert.ok(projection.on.some((rule) => rule.event === "issue.opened"));
    assert.deepEqual(projection.github, { mirror: "push", issues: "two-way", changes: "land" });
    assert.equal(typeof projection.summary, "string");
  });
});

describe("the home pane", () => {
  /**
   * `.smithers/home.json` is generated by `//:factoryProjection` from the
   * `export const home = Smithers.Factory.Home` declaration in
   * `.smithers/FACTORY.ts`; the build's `ci` verb reds on drift. This suite
   * asserts what the pane is made of: declared blocks only, no HTML
   * anywhere, and a flows block whose rows the app takes from the catalog
   * beside it.
   */
  const home = JSON.parse(readFileSync(join(projectionRoot, "home.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(join(projectionRoot, "factory.json"), "utf8"));
  const KNOWN_BLOCKS = ["text", "links", "flows", "ci-benchmark"];

  it("is made of declared blocks and carries no HTML", () => {
    assert.ok(Array.isArray(home.blocks) && home.blocks.length > 0, "the pane declares at least one block");
    for (const block of home.blocks) {
      assert.ok(KNOWN_BLOCKS.includes(block.type), `${block.type} is not a declared block type`);
    }
    const strings = [];
    const walk = (value) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(home);
    for (const text of strings) {
      assert.ok(!/<\/?[A-Za-z!?]/.test(text), `${JSON.stringify(text)} carries HTML`);
      assert.ok(!/[\u2013\u2014]/.test(text), `${JSON.stringify(text)} has an em or en dash`);
    }
  });

  it("says what the repository is, features its flows, and asks for the CI benchmark without inventing numbers", () => {
    const types = home.blocks.map((block) => block.type);
    assert.ok(types.includes("text"), "a text block says what the repository is");
    assert.ok(types.includes("flows"), "a flows block features the catalog's flows");
    const benchmark = home.blocks.find((block) => block.type === "ci-benchmark");
    assert.ok(benchmark, "a ci-benchmark block asks for the CI numbers");
    assert.deepEqual(benchmark.measures, ["cold", "incremental", "cache-hit-rate"]);
    assert.deepEqual(Object.keys(benchmark).sort(), ["measures", "title", "type"], "the benchmark carries no numbers");
    assert.ok(catalog.flows.some((row) => row.featured), "the flows block has featured rows to show");
  });
});

describe("discovery over the project flows directory", () => {
  it("finds the prompt bodies and conservatively projects the release delegates", async () => {
    const scan = await run(
      Effect.gen(function* () {
        const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path);
        return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" });
      }),
    );

    const modules = ["checks/wiki", "coding", "coding/implementation", "coding/request", "coding/vibe", "release", "release-content", "wiki"];
    const [code, message] = DELEGATED.split(": ");
    assert.deepEqual(
      scan.warnings.map((warning) => `${warning.code} at ${relative(flowsRoot, warning.path).split("\\").join("/")}: ${warning.message}`).sort(),
      [
        ...EXPECTED_FLOWS.filter((name) => name.startsWith("checks/")).map((name) => `${code} at ${name}/flow.mdx: ${message}`),
        ...modules.map((name) => `unsupported_module_metadata at ${name}/flow.ts: Flow authority cannot be projected statically; using the conservative wildcard`),
        ...["checks/wiki", "wiki"].map((name) => `unsupported_module_metadata at ${name}/flow.ts: Effect tier sealed under-classifies declared authority; using irreversible`),
      ].sort(),
    );
    assert.deepEqual([...scan.entries].map((entry) => entry.name).sort(), [...EXPECTED_FLOWS, ...modules].sort());
  });

  it("finds no flow inside the 0.x fixture, which is data and not a flow", async () => {
    const scan = await run(
      Effect.gen(function* () {
        const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path);
        return yield* discovery.scan({
          source: "project",
          root: join(flowsRoot, "migrate-smithers-v1"),
          naming: "path",
        });
      }),
    );

    assert.deepEqual([...scan.entries].map((entry) => entry.name), []);
  });
});

describe("the smithers-0x-hello fixture", () => {
  const root = join(flowsRoot, FIXTURE);

  it("is a complete 0.x project on disk", () => {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "FIXTURE.md",
      "simple-workflow.jsx",
      "_example-kit.js",
      ".smithers/workflows/hello.tsx",
      ".smithers/agents/index.ts",
      ".smithers/prompts/hello.mdx",
      ".smithers/ui/hello.tsx",
      "prompts/simple-workflow/research.mdx",
      "prompts/simple-workflow/write.mdx",
    ]) {
      assert.ok(statSync(join(root, file)).isFile(), `${file} is missing from the fixture`);
    }
  });

  it("is committed, `.smithers/` pack included", () => {
    // The repository root ignores `.smithers/`, because that is where a 0.x
    // checkout keeps its run state. Here it is the point of the fixture, so the
    // fixtures directory un-ignores it the way packages/smithers/migrate's does. Without
    // that negation the pack exists on the author's disk and nowhere else, and
    // every test here passes while a fresh clone has no fixture at all.
    const tracked = spawnSync("git", ["ls-files", "--", `flows/${FIXTURE}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(tracked.status, 0, tracked.stderr);
    const files = tracked.stdout.split("\n").filter((line) => line !== "");
    for (const file of [
      ".smithers/workflows/hello.tsx",
      ".smithers/agents/index.ts",
      ".smithers/prompts/hello.mdx",
      ".smithers/ui/hello.tsx",
    ]) {
      assert.ok(
        files.includes(`flows/${FIXTURE}/${file}`),
        `${file} is on disk but not tracked; check the fixtures .gitignore`,
      );
    }
    assert.equal(files.length, 15, "every fixture file is tracked");
  });

  it("is outside every pnpm workspace glob, so its 0.x dependencies never install", () => {
    const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const globs = [...workspace.matchAll(/^ {2}- "([^"]+)"$/gm)].map((match) => match[1]);
    assert.ok(globs.length > 0, "the workspace file must declare package globs");
    for (const glob of globs) {
      assert.ok(!matchesGlob(`flows/${FIXTURE}`, glob), `workspace glob "${glob}" would pick up the fixture`);
    }
  });

  it("is detected as a Smithers 0.x project by the migrate detector", async () => {
    const detection = await run(Detect.scan(root));

    assert.deepEqual(
      detection.manifests.flatMap((manifest) => manifest.oldPackages),
      [{ name: "smthrs", version: "0.35.0", field: "dependencies", reason: "old-name" }],
    );

    const tsconfig = detection.tsconfigs.find((entry) => entry.path === "tsconfig.json");
    assert.equal(tsconfig?.jsx, "react-jsx");
    assert.equal(tsconfig?.jsxImportSource, "smthrs");

    assert.deepEqual(
      detection.workflowFiles.map((entry) => `${entry.path}:${entry.api}:${entry.kind}`).sort(),
      [".smithers/workflows/hello.tsx:smthrs:tsx", "simple-workflow.jsx:smthrs:jsx"],
    );

    assert.deepEqual(detection.prompts.map((entry) => entry.path).sort(), [
      ".smithers/prompts/hello.mdx",
      "prompts/simple-workflow/research.mdx",
      "prompts/simple-workflow/write.mdx",
    ]);

    assert.deepEqual(detection.uis.map((entry) => entry.path), [".smithers/ui/hello.tsx"]);
    assert.equal(detection.effectPin, "4.0.0-beta.105");
    assert.ok(
      detection.warnings.some((warning) => warning.code === "effect-pin-conflict"),
      "the fixture's Effect pin must be reported against the version the 1.0 tree requires",
    );
  });

  it("carries the 0.x CLI verbs its package scripts invoke", async () => {
    const detection = await run(Detect.scan(join(flowsRoot, FIXTURE)));
    assert.deepEqual(
      detection.scripts.map((hit) => hit.text).sort(),
      ["smithers up", "smithers workflow"],
    );
  });

  it("holds no 0.x run state, so the migration gate has nothing to refuse", () => {
    for (const path of [".smithers/smithers.db", "smithers.db", ".smithers/executions"]) {
      assert.throws(() => statSync(join(root, path)), /ENOENT/, `${path} must not exist in the fixture`);
    }
  });
});

describe("the fixture under the real CLI", () => {
  const staged = [];
  after(() => {
    for (const directory of staged) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * A copy of the fixture outside this repository.
   *
   * In place, the fixture resolves its project root to this repository, whose
   * `flows/` directory anchors it, so a command run inside the fixture reads
   * the repository's flows and not the fixture at all. A detached copy is what
   * an external 0.x project looks like.
   */
  const detached = () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-0x-"));
    staged.push(directory);
    const project = join(directory, "project");
    cpSync(join(flowsRoot, FIXTURE), project, { recursive: true });
    return project;
  };

  const smithers = (project, ...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8", timeout: 300_000 });

  it("prints the 0.x-project notice the first time a command runs in it", () => {
    const project = detached();

    const first = smithers(project, "ls");

    assert.equal(first.status, 0, first.stderr);
    // The 0.x run-data warning begins with this text. Building the durable layers
    // creates `.flows/`, which is the very thing the detector reads as "this
    // is an rc.0 project", so a reading taken inside the handler found nothing
    // on precisely the run this notice is written for.
    assert.match(first.stderr, /^Found Smithers 0\.x state at .*\.smithers\./);
    assert.match(first.stderr, /1\.0\.0-rc\.0 does not load, resume, or migrate 0\.x run databases/);
    assert.match(first.stderr, /https:\/\/smithers\.sh\/migration\/1\.0#run-data/);

    const second = smithers(project, "ls");

    // Once `.flows/` exists the project is mid-migration, and the 0.x-project guard stops
    // the notice rather than repeating it on every command forever.
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, "");
  });

  it("passes the migrate verb's 0.x run gate, having no run state to refuse", () => {
    const project = detached();

    const result = smithers(project, "migrate", "--format", "json");

    // The gate reads any 0.x `smithers.db` for non-terminal runs. The fixture
    // has none, so the verb gets past it and reaches the migration tool, which
    // ships inside `@smthrs/migrate` rather than in a `flows/` directory the
    // project being migrated does not have. A refusal here would mean the gate
    // fired on a project with nothing to refuse.
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runState.verdict, "clean");
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes("non-terminal"),
      "the 0.x run gate refused a fixture that holds no run state",
    );
  });

  it("is a project the migration planner reads as 0.x work, not an empty directory", () => {
    const project = detached();

    const result = smithers(project, "migrate", "--format", "json");

    assert.equal(result.status, 0, result.stderr);
    // The fixture exists to give the migration tool something real to plan
    // against. A fixture that planned zero units would pass every gate above
    // and prove nothing, so the counts are the assertion.
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "plan");
    assert.ok(report.units.length >= 3, `the fixture planned only ${report.units.length} units`);
    assert.ok(report.inventory.length > 0, "the planner reported no construct rows");
    assert.ok(report.mapping.length > 0, "the planner reported no mapping decisions");
    // The 0.x `<UI>` element is the construct the 1.0 command contract has no
    // counterpart for, and the fixture carries one so a person sees it.
    assert.match(result.stdout, /\.smithers\/workflows\/hello\.tsx/);
  });
});
