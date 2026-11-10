/**
 * LemmaScript project configuration.
 *
 * Config is discovered per source file, validated from one registry, then
 * layered with eligible file directives before consumers see a resolved set.
 * Filesystem policy stays here/lsc.ts; extractors and emitters receive options.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { ts } from "ts-morph";

export const OPTION_SPECS = {
  "extern-default": {
    type: "enum",
    values: ["pure", "impure"],
    default: "pure",
    fileOverride: true,
    description: "Default model for externs without //@ pure or //@ impure.",
  },
  "safe-slice": {
    type: "boolean",
    default: false,
    fileOverride: true,
    directiveAliases: ["safe-slice"],
    description: "Use JavaScript-clamping semantics for two-argument array slice.",
  },
  "proof-dir": {
    type: "path",
    default: null,
    fileOverride: false,
    description: "Directory for Dafny artifacts, relative to lemmascript.json.",
  },
  "string-semantics": {
    type: "enum",
    values: ["unicode-scalar", "javascript-utf16"],
    default: "unicode-scalar",
    fileOverride: true,
    description: "Which model of JavaScript strings a Dafny proof is made under.",
  },
  "dafny-library": {
    type: "enum",
    values: ["stdlib", "local"],
    default: "stdlib",
    fileOverride: true,
    description: "Use Dafny's standard library or generated local helpers for collection operations.",
  },
  "run-log": {
    type: "boolean",
    default: true,
    fileOverride: false,
    description: "Record lsc check and regen runs in .lemmascript/.",
  },
} as const;

type OptionSpecs = typeof OPTION_SPECS;
type OptionValue<S> =
  S extends { type: "boolean" } ? boolean :
  S extends { type: "enum"; values: readonly (infer V extends string)[] } ? V :
  S extends { type: "path" } ? string | null :
  never;

export type LscOptions = {
  readonly [K in keyof OptionSpecs]: OptionValue<OptionSpecs[K]>;
};
export type ExplicitOptions = Partial<LscOptions>;

export const DEFAULT_OPTIONS = Object.freeze(Object.fromEntries(
  Object.entries(OPTION_SPECS).map(([key, spec]) => [key, spec.default]),
)) as LscOptions;

type AnyOptionSpec = OptionSpecs[keyof OptionSpecs];
const KNOWN_KEYS = Object.keys(OPTION_SPECS) as (keyof OptionSpecs)[];
const CONFIG_CACHE = new Map<string, ExplicitOptions>();

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function isKnownKey(key: string): key is keyof OptionSpecs {
  return Object.hasOwn(OPTION_SPECS, key);
}

/** Validate one option against the registry and return its typed value. */
export function parseOptionValue<K extends keyof LscOptions>(key: K, raw: unknown, source: string): LscOptions[K] {
  const spec = OPTION_SPECS[key] as AnyOptionSpec;
  if (spec.type === "boolean") {
    if (typeof raw !== "boolean") fail(source, `option '${key}' must be true or false`);
    return raw as LscOptions[K];
  }
  if (spec.type === "enum") {
    if (typeof raw !== "string" || !(spec.values as readonly string[]).includes(raw)) {
      fail(source, `option '${key}' must be one of: ${spec.values.join(", ")}`);
    }
    return raw as LscOptions[K];
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail(source, `option '${key}' must be a non-empty relative path`);
  }
  if (path.isAbsolute(raw)) fail(source, `option '${key}' must be relative to lemmascript.json`);
  return raw as LscOptions[K];
}

/** Validate a parsed lemmascript.json object, returning only explicitly set keys. */
export function validateOptions(raw: unknown, source: string): ExplicitOptions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(source, "expected a JSON object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (!isKnownKey(key)) {
      fail(source, `unknown option '${key}' (known options: ${KNOWN_KEYS.join(", ")})`);
    }
    out[key] = parseOptionValue(key, value, source);
  }
  return out as ExplicitOptions;
}

function parseDirectiveValue(key: keyof OptionSpecs, text: string, source: string): LscOptions[typeof key] {
  const spec = OPTION_SPECS[key] as AnyOptionSpec;
  if (spec.type === "boolean") {
    if (text !== "true" && text !== "false") fail(source, `option '${key}' must be true or false`);
    return (text === "true") as LscOptions[typeof key];
  }
  if (spec.type === "enum") return parseOptionValue(key, text, source);
  // Config-only today, but keep the diagnostic precise if a future path is
  // made file-overridable.
  return parseOptionValue(key, text, source);
}

/**
 * Find comment lines, marking those that occur before any code.
 *
 * Use the parsed syntax tree to skip strings, regexes, and template text.
 * Without those boundaries, the scanner can read /[/*]/ as a block comment
 * or treat a template's closing backtick as the start of another template.
 */
function* fileCommentLines(sourceText: string): Generator<{ text: string; index: number; inLeadingRegion: boolean }> {
  // Normalize once so a leading BOM also works before a shebang.
  sourceText = sourceText.replace(/^\uFEFF/, "");
  const lines = sourceText.split(/\r\n|[\n\r\u2028\u2029]/);
  const sourceFile = ts.createSourceFile(
    "lemmascript-options.ts", sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS,
  );
  const literalEnds = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node)) {
      // Skip template text, keeping real comments inside ${...} visible.
      // Missing recovery tokens must not send the scanner back to its start.
      const start = node.getStart(sourceFile);
      if (node.end > start) literalEnds.set(start, node.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceText,
  );
  let inLeadingRegion = true;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const firstLine = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenStart()).line;
      const lastLine = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenEnd() - 1).line;
      for (let index = firstLine; index <= lastLine; index++) {
        yield { text: lines[index], index, inLeadingRegion };
      }
    } else if (token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia &&
               token !== ts.SyntaxKind.ShebangTrivia) {
      inLeadingRegion = false;
      const end = literalEnds.get(scanner.getTokenStart());
      if (end !== undefined) scanner.resetTokenState(end);
    }
  }
}

/** Parse top-of-file `//@ option key value` directives and legacy aliases. */
export function parseFileOptions(sourceText: string, source: string): ExplicitOptions {
  const seen = new Map<keyof OptionSpecs, number>();
  const out: Record<string, unknown> = {};

  const setOption = (key: keyof OptionSpecs, value: LscOptions[typeof key], line: number): void => {
    const previous = seen.get(key);
    if (previous !== undefined) {
      fail(`${source}:${line}`, `duplicate option '${key}' (first set on line ${previous})`);
    }
    seen.set(key, line);
    out[key] = value;
  };

  const parseLine = (lineText: string, index: number, inLeadingRegion: boolean): void => {
    const line = index + 1;
    const optionMatch = lineText.match(/^[ \t]*\/\/@[ \t]+option(?:[ \t]+(.*?))?[ \t]*$/);
    if (optionMatch) {
      if (!inLeadingRegion) fail(`${source}:${line}`, "//@ option directives must appear before the first source statement");
      const parts = (optionMatch[1] ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) fail(`${source}:${line}`, "expected //@ option <key> <value>");
      const [rawKey, rawValue] = parts;
      if (!isKnownKey(rawKey)) {
        fail(`${source}:${line}`, `unknown option '${rawKey}' (known options: ${KNOWN_KEYS.join(", ")})`);
      }
      const spec = OPTION_SPECS[rawKey];
      if (!spec.fileOverride) fail(`${source}:${line}`, `option '${rawKey}' is config-only`);
      setOption(rawKey, parseDirectiveValue(rawKey, rawValue, `${source}:${line}`), line);
      return;
    }

    const aliasMatch = lineText.match(/^[ \t]*\/\/@[ \t]+([A-Za-z][A-Za-z0-9-]*)[ \t]*$/);
    if (!aliasMatch) return;
    const alias = aliasMatch[1];
    for (const key of KNOWN_KEYS) {
      const aliases = "directiveAliases" in OPTION_SPECS[key]
        ? OPTION_SPECS[key].directiveAliases as readonly string[]
        : [];
      if (!aliases.includes(alias)) continue;
      // Legacy aliases retain their pre-config placement behavior. New generic
      // option directives are deliberately restricted to the file preamble.
      setOption(key, true as LscOptions[typeof key], line);
      return;
    }
  };

  for (const { text, index, inLeadingRegion } of fileCommentLines(sourceText)) {
    parseLine(text, index, inLeadingRegion);
  }
  return out as ExplicitOptions;
}

/** Apply defaults, check option compatibility, and freeze the resolved configuration. */
export function resolveOptions(explicit: ExplicitOptions, source: string): LscOptions {
  const options = { ...DEFAULT_OPTIONS, ...explicit };
  // Dafny's precompiled standard library uses Unicode-scalar characters.
  if (options["string-semantics"] === "javascript-utf16" && options["dafny-library"] === "stdlib") {
    fail(source, '"string-semantics": "javascript-utf16" is incompatible with "dafny-library": "stdlib"; set "dafny-library": "local" explicitly');
  }
  return Object.freeze(options);
}

/** Find `fileName` at or above `fromPath`. */
export function findUp(fileName: string, fromPath: string, fromIsDirectory = false): string | null {
  let dir = fromIsDirectory ? path.resolve(fromPath) : path.dirname(path.resolve(fromPath));
  while (true) {
    const candidate = path.join(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Discover, parse, and validate a config without materializing defaults. */
export function loadConfigOptions(
  sourcePath: string,
  configPath?: string,
): { explicit: ExplicitOptions; configFile: string | null } {
  const configFile = configPath ? path.resolve(configPath) : findUp("lemmascript.json", sourcePath);
  if (!configFile) return { explicit: {}, configFile: null };
  if (!existsSync(configFile)) fail(configFile, "config file not found");

  const cached = CONFIG_CACHE.get(configFile);
  if (cached) return { explicit: { ...cached }, configFile };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(configFile, `invalid JSON (${detail})`);
  }
  const explicit = validateOptions(parsed, configFile);
  CONFIG_CACHE.set(configFile, explicit);
  return { explicit: { ...explicit }, configFile };
}

/** Resolve the directory containing one source file's Dafny companions. */
export function resolveDafnyArtifactDir(
  sourcePath: string,
  configFile: string | null,
  options: LscOptions,
): string {
  const source = path.resolve(sourcePath);
  const proofDir = options["proof-dir"];
  if (proofDir === null) return path.dirname(source);
  if (!configFile) fail(source, "proof-dir requires a lemmascript.json file");

  const configDir = path.dirname(path.resolve(configFile));
  const relativeSource = path.relative(configDir, source);
  if (relativeSource === ".." || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
    fail(source, `is outside the config directory ${configDir}; cannot map proof-dir`);
  }
  const proofRoot = path.resolve(configDir, proofDir);
  return path.join(proofRoot, path.dirname(relativeSource));
}
