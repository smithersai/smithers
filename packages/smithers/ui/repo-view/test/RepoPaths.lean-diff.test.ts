/**
 * The repository path helpers against their Lean 4 reference specification (`spec/lean/repo_paths`), generated:
 * every case is answered by `src/paths.ts` and by the specification's compiled oracle, and the two answers must be
 * equal, code unit for code unit.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, so a lone surrogate and a NUL arrive as they left.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 *
 * Replay a failure by running this file with the reported EFFECT_FUZZ_SEED and EFFECT_FUZZ_EXECUTIONS.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import {
  ancestorsOf,
  compareNames,
  directoriesOf,
  directoryEntries,
  formatBytes,
  isHtml,
  isMarkdown,
  lineCount,
  parentOf,
  resolveLink,
  treeOrder,
} from "../src/paths";

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123");
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"));
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(baseExecutions) || baseExecutions < 1) {
  throw new RangeError("Fuzzing requires an integer seed and a positive integer execution count");
}
const executions = Math.max(25, Math.min(baseExecutions, 500));

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "repo_paths");
const binary = join(specDir, ".lake", "build", "bin", "repo-paths-spec");
const elan = join(homedir(), ".elan", "bin");
const lake = [...(process.env.PATH ?? "").split(delimiter).filter(directory => directory !== ""), elan]
  .map(directory => join(directory, "lake"))
  .find(path => existsSync(path));
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"));
const oracleReady = existsSync(binary) || buildable;
const differential = test.skipIf(!oracleReady);

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
function stale(): boolean {
  if (!existsSync(binary)) return true;
  const built = statSync(binary).mtimeMs;
  const sources = [
    "Main.lean",
    "RepoPathsSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "RepoPathsSpec")).map(name => join("RepoPathsSpec", name)),
  ];
  return sources.some(source => statSync(join(specDir, source)).mtimeMs > built);
}

type Oracle = {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly asked: () => number;
  readonly close: () => void;
};

function start(): Oracle {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = [];
  let asked = 0;
  createInterface({ input: child.stdout }).on("line", line => {
    const next = waiting.shift();
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string };
    if (response.error === undefined) next?.resolve(response.ok);
    else next?.reject(new Error(`the oracle refused: ${response.error}`));
  });
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"));
  });
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++;
        waiting.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`);
      }),
    asked: () => asked,
    close: () => child.stdin.end(),
  };
}

let oracle: Oracle;

beforeAll(() => {
  if (!oracleReady) return;
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env.PATH ?? ""}` },
    });
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`);
  }
  oracle = start();
});

afterAll(() => {
  if (oracleReady) oracle.close();
});

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>;

/** A text as its UTF-16 code units. */
const units = (text: string): number[] => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));

type LinkCase = {
  readonly from: string;
  readonly href: string;
  readonly paths: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<string>;
};

/** `resolveLink` by the implementation and by the oracle: the same refusal, or the same kind and path. */
async function linkAgrees(input: LinkCase): Promise<ReturnType<typeof resolveLink>> {
  const actual = resolveLink(input.from, input.href, input.paths, input.folders);
  const expected = await oracle.ask("resolveLink", {
    from: units(input.from),
    href: units(input.href),
    paths: input.paths.map(units),
    folders: input.folders.map(units),
  });
  expect(actual === undefined ? null : { kind: actual.kind, path: units(actual.path) }).toEqual(expected as never);
  return actual;
}

/** `parentOf`, `ancestorsOf` and `directoriesOf` by the implementation and by the oracle. */
async function pathAgrees(path: string): Promise<void> {
  expect(units(parentOf(path))).toEqual((await oracle.ask("parentOf", { path: units(path) })) as number[]);
  expect(ancestorsOf(path).map(units)).toEqual((await oracle.ask("ancestorsOf", { path: units(path) })) as number[][]);
}

async function directoriesAgree(paths: ReadonlyArray<string>, folders: ReadonlyArray<string>): Promise<void> {
  const expected = await oracle.ask("directoriesOf", { paths: paths.map(units), folders: folders.map(units) });
  expect([...directoriesOf(paths, folders)].map(units)).toEqual(expected as number[][]);
}

// --- generation -----------------------------------------------------------------------------------------------------

type Draw = (exclusive: number) => number;

function mulberry32(start: number): Draw {
  let state = start >>> 0;
  return exclusive => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), 1 | state);
    word ^= word + Math.imul(word ^ (word >>> 7), 61 | word);
    return Math.floor(((word ^ (word >>> 14)) >>> 0) / 0x100000000 * exclusive);
  };
}

function pick<T>(draw: Draw, items: readonly T[]): T {
  return items[draw(items.length)]!;
}

function many<T>(draw: Draw, maximum: number, element: () => T): T[] {
  return Array.from({ length: draw(maximum + 1) }, element);
}

/**
 * Runs `check` on `executions` generated inputs. Each input comes from its own stream, seeded from the property's
 * name, so one failing input replays alone; the failure names the seed, the iteration and the input's code units.
 */
function property<T>(name: string, generate: (draw: Draw) => T, check: (input: T) => Promise<void>, runs = executions): void {
  differential(name, async () => {
    const salt = Array.from(name).reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 16777619), seed);
    const next = mulberry32(salt);
    for (let iteration = 1; iteration <= runs; iteration++) {
      const input = generate(mulberry32(next(0x100000000)));
      try {
        await check(input);
      } catch (cause) {
        const shown = JSON.stringify(input, (_, value) => (typeof value === "string" ? units(value) : value));
        throw new Error(`EFFECT_FUZZ_SEED=${seed} EFFECT_FUZZ_EXECUTIONS=${iteration}\nInput (code units): ${shown}`, {
          cause,
        });
      }
    }
  });
}

const hex = (byte: number): string => `%${byte.toString(16).padStart(2, "0")}`;
const upper = (text: string): string => text.toUpperCase();

/** Names a repository holds: plain, spaced, accented, astral, and ones a URL would read as syntax. */
const components = ["src", "SRC", "docs", "a", "b", "a b", "naïve", "漢", "🙂", "a#b", "q?", "100%", "__proto__", "a\\b",
  "..a", "a..", "...", ".git", "x:y"];

/** Escapes that decode, escapes that must not, and text that only looks like an escape. */
const escapes = ["%", "%%", "%2", "%2g", "%zz", "%g0", "%25", "%2525", "%20", "%41", "%7e", "%7F",
  "%2e", "%2E", "%2e%2e", "%2E%2e", ".%2e", "%2e.", "%2e%2e%2e", "%2f", "%2F", "a%2fb", "%5c", "%00", "a%00b", "%23", "%3f",
  "%c3%a9", "%C3%A9", "%c3", "%c3%28", "%c3%", "%c3%a", "%c3a9", "%a9", "%80", "%bf", "%c0%af", "%c1%bf", "%c2%80",
  "%df%bf", "%e0%80%af", "%e0%9f%bf", "%e0%a0%80", "%e2%82%ac", "%e2%82", "%e2%28%a1", "%ed%9f%bf", "%ed%a0%80",
  "%ed%bf%bf", "%ee%80%80", "%ef%bf%bf", "%ef%bf%be", "%f0%80%80%80", "%f0%8f%bf%bf", "%f0%90%80%80", "%f0%9f%99%82",
  "%f0%9f%99", "%f0%9f%99%", "%f4%8f%bf%bf", "%f4%90%80%80", "%f5%80%80%80", "%f8%88%80%80%80", "%fc%84%80%80%80%80",
  "%fe", "%ff", "%ed%a0%bd%ed%b9%82", "%d8%00", "%E2%82%AC%", "%25%32%65", "%252e%252e", "%u0041", "%ud83d"];

/** Units a hostile link is made of: controls, both surrogate halves, syntax, and the edges of the unit range. */
const atoms = ["", "a", "0", " ", "\n", "\r", "\t", "\0", "\u001f", "\u007f", "\u0080", "Ω", "漢", "🙂", "é",
  "\ud800", "\udbff", "\udc00", "\udfff", "\ud83d", "\ude42", "￾", "￿", "&", "<", "/", "\\", ".", "..", ":",
  "?", "#", "%", "+", "-", "//", "/./", "/../"];

const noise = (draw: Draw): string =>
  many(draw, 12, () => (draw(5) === 0 ? String.fromCharCode(draw(65536)) : pick(draw, atoms))).join("");

/** One to four random escaped bytes, each as likely to break a UTF-8 sequence as to continue one. */
const bytes = (draw: Draw): string =>
  Array.from({ length: 1 + draw(4) }, () => {
    const byte = pick(draw, [draw(256), 0x80 + draw(64), 0xc0 + draw(64), draw(128)]);
    return draw(2) === 0 ? hex(byte) : upper(hex(byte));
  }).join("");

/** One piece of a link between two `/`. */
const piece = (draw: Draw): string => {
  switch (draw(9)) {
    case 0: return pick(draw, [".", "..", "", ".", ".."]);
    case 1: return pick(draw, escapes);
    case 2: return bytes(draw);
    case 3: return encodeURIComponent(pick(draw, components));
    case 4: return pick(draw, components) + pick(draw, escapes);
    case 5: return noise(draw).replaceAll("/", "");
    case 6: return pick(draw, escapes) + pick(draw, atoms) + bytes(draw);
    default: return pick(draw, components);
  }
};

const directory = (draw: Draw, depth: number): string => many(draw, depth, () => pick(draw, components)).join("/");

/** A document's path: usually clean, sometimes with doubled, leading or trailing separators or hostile names. */
const document = (draw: Draw): string => {
  const clean = [...many(draw, 4, () => pick(draw, components)), "README.md"].join("/");
  switch (draw(8)) {
    case 0: return `/${clean}`;
    case 1: return clean.replace("/", "//");
    case 2: return `${directory(draw, 3)}/`;
    case 3: return [...many(draw, 3, () => pick(draw, ["..", ".", "", "\0", "\ud800", "a"])), "x"].join("/");
    case 4: return noise(draw);
    default: return clean;
  }
};

/** The files and folders of a small repository over the same names, so a resolved path is often a directory. */
const repository = (draw: Draw): { readonly paths: string[]; readonly folders: string[] } => ({
  paths: many(draw, 5, () => [directory(draw, 3), pick(draw, components)].filter(Boolean).join("/")),
  folders: many(draw, 3, () => pick(draw, [directory(draw, 3), `${directory(draw, 2)}/`, "", `/${directory(draw, 1)}`])),
});

const link = (draw: Draw): string => {
  const prefix = pick(draw, ["", "", "", "/", "./", "../", "../../", "/./", "/../", "//", "///", "x:", "http://",
    "JavaScript:", "a+b.c-d:", "1x:", "+x:", ":", "?", "#"]);
  const body = many(draw, 6, () => piece(draw)).join("/");
  const trailing = pick(draw, ["", "", "/", "//", "/."]);
  const suffix = pick(draw, ["", "", "", "?plain=1", "#a/b", "?q#z", "#", "?", "?a/..", "#\n/", "?\n#x:"]);
  return prefix + body + trailing + suffix;
};

// --- resolveLink ----------------------------------------------------------------------------------------------------

describe("resolveLink against the Lean specification", () => {
  let resolved = 0;
  let refused = 0;
  let trees = 0;
  let blobs = 0;

  property("links built from pieces, escapes and dot segments resolve as the specification does", draw => ({
    from: document(draw),
    href: link(draw),
    ...repository(draw),
  }), async input => {
    const target = await linkAgrees(input);
    if (target === undefined) refused++;
    else {
      resolved++;
      if (target.kind === "tree") trees++;
      else blobs++;
    }
  }, executions * 4);

  differential("the generated links reached every outcome: refused, tree and blob", () => {
    expect(refused).toBeGreaterThan(executions / 2);
    expect(resolved).toBeGreaterThan(executions / 2);
    expect(trees).toBeGreaterThan(10);
    expect(blobs).toBeGreaterThan(10);
  });

  property("clean relative navigation lands on the specification's directory or file", draw => {
    const base = many(draw, 4, () => pick(draw, components));
    const repo = repository(draw);
    const steps = many(draw, 6, () => pick(draw, [".", "..", "%2e", "%2E%2E", ...components.map(encodeURIComponent)]));
    return {
      from: [...base, "guide.md"].join("/"),
      href: pick(draw, ["", "./", "/"]) + steps.join("/") + pick(draw, ["", "/", "?x", "#y"]),
      paths: [...repo.paths, [...base, "guide.md"].join("/")],
      folders: repo.folders,
    };
  }, async input => {
    await linkAgrees(input);
  }, executions * 2);

  property("arbitrary code units, lone surrogates and NULs included, resolve as the specification does", draw => ({
    from: draw(2) === 0 ? noise(draw) : document(draw),
    href: noise(draw) + pick(draw, ["", "/", "%2e%2e", "%00", "\0", "?", "#"]) + noise(draw),
    paths: many(draw, 3, () => noise(draw)),
    folders: many(draw, 3, () => noise(draw)),
  }), async input => {
    await linkAgrees(input);
  }, executions * 2);

  property("a resolved path has only the components the specification proves it has", draw => ({
    from: [...many(draw, 4, () => pick(draw, components)), "README.md"].join("/"),
    href: many(draw, 10, () =>
      pick(draw, [".", "..", "%2e", "%2e%2e", "%2f", "%00", "\0", "/", "a", "b", "?", "#", noise(draw), bytes(draw)])).join(""),
    paths: [],
    folders: [],
  }), async input => {
    const target = await linkAgrees(input);
    if (target === undefined || target.path === "") return;
    for (const part of target.path.split("/")) {
      expect(part).not.toBe("");
      expect(part).not.toBe(".");
      expect(part).not.toBe("..");
      expect(part.includes("\0")).toBe(false);
    }
  }, executions * 2);

  differential("every escaped byte sequence decodes, or refuses, as the specification's UTF-8 decoder does", async () => {
    const seconds = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff];
    const thirds = [0x7f, 0x80, 0xbf, 0xc0];
    let decoded = 0;
    for (let lead = 0; lead < 256; lead++) {
      await linkAgrees({ from: "", href: hex(lead), paths: [], folders: [] });
      expect(await linkAgrees({ from: "d/f", href: `x${upper(hex(lead))}y`, paths: [], folders: [] })).toEqual(
        lead === 0x2f || lead === 0x00 || lead >= 0x80 ? undefined : { kind: "blob", path: `d/x${String.fromCharCode(lead)}y` },
      );
      if (lead < 0x80) continue;
      for (const second of seconds) {
        await linkAgrees({ from: "", href: hex(lead) + hex(second), paths: [], folders: [] });
        for (const third of thirds) {
          await linkAgrees({ from: "", href: hex(lead) + hex(second) + hex(third), paths: [], folders: [] });
          for (const fourth of thirds) {
            const target = await linkAgrees({
              from: "",
              href: hex(lead) + hex(second) + hex(third) + hex(fourth),
              paths: [],
              folders: [],
            });
            if (target !== undefined) decoded++;
          }
        }
      }
    }
    expect(decoded).toBeGreaterThan(100);
  });

  differential("every code point at a UTF-8 length boundary round-trips, in either hexadecimal case", async () => {
    const points = [0x01, 0x24, 0x7f, 0x80, 0x7ff, 0x800, 0xfff, 0x1000, 0xd7ff, 0xe000, 0xfffd, 0xffff, 0x10000,
      0x1f642, 0xfffff, 0x100000, 0x10ffff];
    for (const point of points) {
      const text = String.fromCodePoint(point);
      for (const href of [encodeURIComponent(text), encodeURIComponent(text).toLowerCase(), text]) {
        expect(await linkAgrees({ from: "a/b", href, paths: [], folders: [] })).toEqual({ kind: "blob", path: `a/${text}` });
      }
    }
  });

  differential("the boundaries agree: nothing, anchors, schemes, the root, traversal and encoded smuggling", async () => {
    const paths = ["src/router.ts", "docs/guide.md", "docs/api/index.md"];
    const at = (from: string, href: string, folders: ReadonlyArray<string> = []) =>
      linkAgrees({ from, href, paths, folders });
    for (const href of ["", "#", "#top", "?", "?q=1", "?#", "#?", "x:", "http://a", "HTTPS://a", "mailto:a@b", "a+b.c-d:",
      "javascript:alert(1)", "z:", "A1:", "//", "//host/x", "///", "\0", "%00", "a%00", "%2f", "%2F", "a%2fb", "%c3",
      "%ed%a0%80", "%ff", "..", "../..", "%2e%2e", "%2E%2E/x", "../docs/../../x", "/..", "/%2e%2e", "/a/../..",
      "./../..", "a/../../.."]) {
      expect(await at("README.md", href)).toBeUndefined();
    }
    expect(await at("docs/guide.md", "../..")).toBeUndefined();
    expect(await at("docs/guide.md", "..")).toEqual({ kind: "tree", path: "" });
    expect(await at("docs/guide.md", "%2e%2e")).toEqual({ kind: "tree", path: "" });
    expect(await at("docs/guide.md", "/")).toEqual({ kind: "tree", path: "" });
    expect(await at("docs/guide.md", ".")).toEqual({ kind: "tree", path: "docs" });
    expect(await at("docs/guide.md", "./")).toEqual({ kind: "tree", path: "docs" });
    expect(await at("docs/guide.md", "api")).toEqual({ kind: "tree", path: "docs/api" });
    expect(await at("docs/guide.md", "api/index.md")).toEqual({ kind: "blob", path: "docs/api/index.md" });
    expect(await at("docs/guide.md", "missing/")).toEqual({ kind: "tree", path: "docs/missing" });
    expect(await at("docs/guide.md", "missing")).toEqual({ kind: "blob", path: "docs/missing" });
    expect(await at("docs/guide.md", "/vendor", ["vendor"])).toEqual({ kind: "tree", path: "vendor" });
    expect(await at("docs/guide.md", "/vendor/x", ["vendor/x/"])).toEqual({ kind: "blob", path: "vendor/x" });
    expect(await at("docs/guide.md", "%2e%2e/src/router.ts")).toEqual({ kind: "blob", path: "src/router.ts" });
    expect(await at("docs/guide.md", "%2e/a.md?x#y")).toEqual({ kind: "blob", path: "docs/a.md" });
    expect(await at("docs/guide.md", "a/#/../..")).toEqual({ kind: "tree", path: "docs/a" });
    expect(await at("docs/guide.md", "1x:y")).toEqual({ kind: "blob", path: "docs/1x:y" });
    expect(await at("docs/guide.md", ":x")).toEqual({ kind: "blob", path: "docs/:x" });
    expect(await at("docs/guide.md", "a/b:c")).toEqual({ kind: "blob", path: "docs/a/b:c" });
    expect(await at("docs/guide.md", "./x:y")).toEqual({ kind: "blob", path: "docs/x:y" });
    expect(await at("docs/guide.md", "/a//b///c")).toEqual({ kind: "blob", path: "a/b/c" });
    expect(await at("docs/guide.md", "100%")).toEqual({ kind: "blob", path: "docs/100%" });
    expect(await at("docs/guide.md", "%zz%2")).toEqual({ kind: "blob", path: "docs/%zz%2" });
    expect(await at("docs/guide.md", "%2525")).toEqual({ kind: "blob", path: "docs/%25" });
    expect(await at("docs/guide.md", "%252e%252e")).toEqual({ kind: "blob", path: "docs/%2e%2e" });
    expect(await at("docs/guide.md", "..%2e")).toEqual({ kind: "blob", path: "docs/..." });
    expect(await at("docs/guide.md", "..\\x")).toEqual({ kind: "blob", path: "docs/..\\x" });
    expect(await at("docs/guide.md", "%5c..%5c")).toEqual({ kind: "blob", path: "docs/\\..\\" });
    expect(await at("docs/guide.md", "\ud800")).toEqual({ kind: "blob", path: "docs/\ud800" });
    expect(await at("docs/guide.md", "\udc00\ud800")).toEqual({ kind: "blob", path: "docs/\udc00\ud800" });
    expect(await at("docs/guide.md", "%f0%9f%99%82")).toEqual({ kind: "blob", path: "docs/🙂" });
    expect(await at("docs/guide.md", "a\nb?c")).toEqual({ kind: "blob", path: "docs/a\nb" });
    expect(await at("//docs///guide.md", "x")).toEqual({ kind: "blob", path: "docs/x" });
    // The document's own path is taken as given: only the link is untrusted, which the specification states.
    expect(await at("../a", "b")).toEqual({ kind: "blob", path: "../b" });
    expect(await at("../a", "/b")).toEqual({ kind: "blob", path: "b" });
    const deep = Array.from({ length: 200 }, (_, index) => `d${index}`);
    expect(await at([...deep, "f"].join("/"), "../".repeat(200))).toEqual({ kind: "tree", path: "" });
    expect(await at([...deep, "f"].join("/"), "../".repeat(201))).toBeUndefined();
    expect(await at([...deep, "f"].join("/"), "%2E%2e/".repeat(201))).toBeUndefined();
    expect((await at("f", deep.join("/")))?.path).toBe(deep.join("/"));
  });
});

// --- parentOf, ancestorsOf, directoriesOf ---------------------------------------------------------------------------

describe("directories against the Lean specification", () => {
  const anyPath = (draw: Draw): string =>
    pick(draw, [
      () => [directory(draw, 5), pick(draw, components)].filter(Boolean).join("/"),
      () => many(draw, 6, () => pick(draw, ["", "", "a", "b", ".", "..", "\0", "\ud800", "🙂", "漢"])).join("/"),
      () => noise(draw),
      () => "/".repeat(draw(5)),
    ])();

  property("parentOf and ancestorsOf agree on clean paths, doubled separators and arbitrary code units", anyPath,
    async path => {
      await pathAgrees(path);
      const ancestors = ancestorsOf(path);
      // The laws the specification proves: one ancestor per part but the last, each a prefix of the next.
      expect(ancestors).toHaveLength(Math.max(0, path.split("/").filter(Boolean).length - 1));
      for (let index = 1; index < ancestors.length; index++) {
        expect(ancestors[index]!.startsWith(`${ancestors[index - 1]!}/`)).toBe(true);
      }
      const pieces = path.split("/");
      if (pieces.length >= 2 && pieces.every(Boolean)) expect(ancestors.at(-1)).toBe(parentOf(path));
    }, executions * 2);

  property("directoriesOf lists the specification's directories, each once, in the same order", draw => ({
    paths: many(draw, 8, () => anyPath(draw)),
    folders: many(draw, 5, () => anyPath(draw)),
  }), async ({ paths, folders }) => {
    await directoriesAgree(paths, folders);
    await directoriesAgree(paths, []);
  });

  differential("the boundaries agree: the empty path, the root, separators only, one name, a deep path", async () => {
    const deep = Array.from({ length: 150 }, (_, index) => `d${index}`).join("/");
    for (const path of ["", "/", "//", "a", "/a", "a/", "a/b", "/a/b/", "a//b", "a/./b", "\0/\0", "\ud83d/\ude42", deep]) {
      await pathAgrees(path);
    }
    expect(parentOf("a/b/c.ts")).toBe("a/b");
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorsOf(deep)).toHaveLength(149);
    await directoriesAgree([], []);
    await directoriesAgree(["a/b/c", "a/b/d", "a/e"], ["", "x", "a/b", "y/", "/z", "a//q"]);
    await directoriesAgree([deep, deep], [deep]);
  });
});

// The specification models links and directories. The module's listing and labelling helpers are pinned here by
// their documented examples, so this file alone exercises every function of `src/paths.ts`.
describe("the helpers beside the specified ones", () => {
  test("listings put directories first and order names case-insensitively, the raw name breaking ties", () => {
    expect(["b", "A", "a", "B"].sort(compareNames)).toEqual(["a", "A", "b", "B"]);
    const paths = ["src/b.ts", "src/a/x.ts", "src/A.ts", "README.md", "src/a/y.ts"];
    expect(directoryEntries(paths, "src", ["src/zed", ""])).toEqual([
      { name: "a", path: "src/a", kind: "directory" },
      { name: "zed", path: "src/zed", kind: "directory" },
      { name: "A.ts", path: "src/A.ts", kind: "file" },
      { name: "b.ts", path: "src/b.ts", kind: "file" },
    ]);
    expect(directoryEntries(paths, "").map(entry => entry.name)).toEqual(["src", "README.md"]);
    expect(treeOrder(paths)).toEqual(["src/a/x.ts", "src/a/y.ts", "src/A.ts", "src/b.ts", "README.md"]);
    // Every directory a listing shows is one `directoriesOf` names.
    const directories = directoriesOf(paths, ["src/zed"]);
    for (const entry of directoryEntries(paths, "src", ["src/zed"])) {
      expect(directories.has(entry.path)).toBe(entry.kind === "directory");
    }
  });

  test("file kinds, line counts and sizes read as documented", () => {
    expect(["a.html", "a.HTM", "a.htmlx", "html"].map(isHtml)).toEqual([true, true, false, false]);
    expect(["a.md", "a.MDX", "a.markdown", "a.mdown", "md"].map(isMarkdown)).toEqual([true, true, true, false, false]);
    expect(["", "a", "a\n", "a\nb", "\n"].map(lineCount)).toEqual([0, 1, 1, 2, 1]);
    expect([587, 1024, 1229, 1024 * 1024, 3_565_158].map(formatBytes)).toEqual([
      "587 B",
      "1.0 KB",
      "1.2 KB",
      "1.0 MB",
      "3.4 MB",
    ]);
  });
});

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope");
    await expect(oracle.ask("parentOf", { path: "not units" })).rejects.toThrow("the oracle refused");
    expect(await oracle.ask("parentOf", { path: units("a/b") })).toEqual([97]);
  });

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(0);
    expect(oracle.asked()).toBeGreaterThan(executions * 10);
  });
});
