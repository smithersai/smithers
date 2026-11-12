#!/usr/bin/env node
/**
 * lsc — LemmaScript compiler CLI
 *
 * Pipeline: extract → resolve → narrow → transform → peephole → emit
 *
 * @since 0.1.0
 */

import { Project, ScriptTarget, type SourceFile } from "ts-morph";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { extractModule } from "./extract.js";
import { desugarMessageUnions } from "./message-union.js";
import { resolveModule } from "./resolve.js";
import { narrowModule } from "./narrow.js";
import { autoHavocModule } from "./autohavoc.js";
import { transformModuleLean, transformModuleDafny } from "./transform.js";
import { peepholeModule } from "./peephole.js";
import { emitLeanFile, resetLeanModule } from "./lean-emit.js";
import { emitDafnyFile, emittedNameMap } from "./dafny-emit.js";
import { dafnyGen, dafnyCheckDiff, dafnyVerify, dafnyRegen } from "./dafny-commands.js";
import { leanGen, leanCheck } from "./lean-commands.js";
import { runInfo, runTypedInfo, type TypedInfoDafny } from "./info-command.js";
import { RunLog, resolveLogDir, runLogEnabled, safely } from "./run-log.js";
import { runRuns } from "./runs-command.js";
import {
  findUp,
  loadConfigOptions,
  parseFileOptions,
  resolveDafnyArtifactDir,
  resolveOptions,
  type LscOptions,
} from "./config.js";

/** Version of the lemmascript package — the root package.json sits two levels
 *  above this module from both tools/src/ (tsx) and tools/dist/ (installed). */
function lscVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return pkg.version as string;
}

function main() {
  const args = process.argv.slice(2);

  // `lsc version` — print the package version. Machine consumers (satellites
  // like lemmascript-claimcheck/-crosscheck) use this for their version
  // handshake; keep the output to the bare semver string.
  if (args[0] === "version") {
    console.log(lscVersion());
    return;
  }

  // `lsc claimcheck <file.ts> …` forwards verbatim to the lemmascript-claimcheck
  // CLI (a dependency; its cli reads the rewritten process.argv). With no
  // leading <file.ts>, batch: one satellite run per LemmaScript-files.txt entry,
  // flags passed through unchanged — the loop is owned here, the satellite
  // stays single-file.
  if (args[0] === "claimcheck") {
    const rest = args.slice(1);
    const missing = () => {
      console.error("`lsc claimcheck` needs lemmascript-claimcheck >= 0.2.0; reinstall with: npm i -g lemmascript");
      process.exit(1);
    };
    if (rest[0] && !rest[0].startsWith("-")) {
      process.argv = [process.argv[0], "lemmascript-claimcheck", ...rest];
      import("lemmascript-claimcheck/cli" as string).catch((err: unknown) => {
        const code = (err as { code?: string })?.code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") missing();
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
      return;
    }
    let cli: string;
    try {
      cli = createRequire(import.meta.url).resolve("lemmascript-claimcheck/cli");
    } catch {
      missing();
      return;
    }
    for (const e of readEntries()) {
      try {
        execFileSync(process.execPath, [cli, e.file, ...rest], { stdio: "inherit" });
      } catch {
        process.exit(1);
      }
    }
    return;
  }

  // `lsc runs` reads the run log and takes its own flags (`--json`, `--config=`),
  // so it is dispatched before the file commands' flag parsing.
  if (args[0] === "runs") {
    runRuns(args.slice(1));
    return;
  }

  const backendIdx = args.findIndex(a => a.startsWith("--backend="));
  let backend: "lean" | "dafny" = "dafny";
  if (backendIdx >= 0) {
    const val = args[backendIdx].split("=")[1];
    if (val !== "lean" && val !== "dafny") {
      console.error(`Unknown backend: ${val}. Use --backend=lean or --backend=dafny`);
      process.exit(1);
    }
    backend = val;
    args.splice(backendIdx, 1);
  }

  const configIdx = args.findIndex(a => a.startsWith("--config="));
  let configPath: string | undefined;
  if (configIdx >= 0) {
    configPath = args[configIdx].slice("--config=".length);
    if (!configPath) {
      console.error("Invalid --config: expected a path after '='");
      process.exit(1);
    }
    args.splice(configIdx, 1);
  }

  const timeLimitIdx = args.findIndex(a => a.startsWith("--time-limit="));
  let timeLimit: number | undefined;
  if (timeLimitIdx >= 0) {
    const val = args[timeLimitIdx].split("=")[1];
    if (!/^[1-9]\d*$/.test(val)) {
      console.error(`Invalid --time-limit: ${val} (expected seconds as a positive integer)`);
      process.exit(1);
    }
    timeLimit = parseInt(val);
    args.splice(timeLimitIdx, 1);
  }

  const extraFlagsIdx = args.findIndex(a => a.startsWith("--extra-flags="));
  let extraFlags: string | undefined;
  if (extraFlagsIdx >= 0) {
    extraFlags = args[extraFlagsIdx].split("=").slice(1).join("=");
    args.splice(extraFlagsIdx, 1);
  }

  // --slow (batch mode only): verify entries with long manifest timeouts
  // instead of degrading them to gen-check.
  let slow = false;
  const slowIdx = args.indexOf("--slow");
  if (slowIdx >= 0) {
    slow = true;
    args.splice(slowIdx, 1);
  }

  // --no-verify (regen only): do regen + three-way merge + additions-only check
  // but skip `dafny verify`. CI's `tools` job passes this to regen-dafny.sh so
  // regen only enforces the drift + additions-only invariants; the separate
  // `lsc check` pass over the same files does the one and only verification.
  let noVerify = false;
  const noVerifyIdx = args.indexOf("--no-verify");
  if (noVerifyIdx >= 0) {
    noVerify = true;
    args.splice(noVerifyIdx, 1);
  }

  // --typed (info only): print the machine-readable Typed IR contract to
  // stdout instead of writing the human-oriented foo.ts.json.
  let typedInfo = false;
  const typedIdx = args.indexOf("--typed");
  if (typedIdx >= 0) {
    typedInfo = true;
    args.splice(typedIdx, 1);
  }

  // Anything flag-shaped left over is a typo or a space-separated form
  // (`--backend lean`): reject it rather than let it become a positional arg
  // or be silently ignored (which would e.g. verify with the wrong backend).
  const stray = args.find(a => a.startsWith("-"));
  if (stray) {
    console.error(`Unknown flag: ${stray} (flags take the form --flag=value, e.g. --backend=dafny)`);
    process.exit(1);
  }

  const [cmd, filePath] = args;
  if (!cmd) {
    console.error("Usage: lsc <gen|check|regen|extract|info> [--backend=lean|dafny] [--config=path] <file.ts>");
    console.error("       lsc config [--config=path] [<file.ts>]");
    console.error("       lsc info --typed <file.ts>   (machine-readable Typed IR contract to stdout)");
    console.error("       lsc <gen|gen-check|check> [--backend=…] [--slow]   (no file: batch over LemmaScript-files.txt)");
    console.error("       lsc claimcheck [<file.ts>] [flags…]   (forwards to lemmascript-claimcheck)");
    console.error("       lsc runs [--json] [--config=path]   (what verification caught, from .lemmascript/runs.jsonl)");
    console.error("       lsc version");
    process.exit(1);
  }
  if (typedInfo && cmd !== "info") {
    console.error(`--typed is only valid with the info command (got: ${cmd})`);
    process.exit(1);
  }
  if (cmd === "config") {
    runConfig(filePath, configPath);
    return;
  }
  if (!filePath) {
    runBatch(cmd, backend, slow, timeLimit, extraFlags, configPath);
    return;
  }
  runFile(cmd, filePath, backend, timeLimit, extraFlags, noVerify, typedInfo, configPath);
}

// LemmaScript-files.txt, parsed: `filepath [timeout_in_seconds] [extra dafny
// flags…]` per line; no timeout = Dafny default. Exits if the file is absent.
function readEntries(): { file: string; timeout?: number; flags?: string }[] {
  if (!existsSync("LemmaScript-files.txt")) {
    console.error("No file given and no LemmaScript-files.txt found.");
    process.exit(1);
  }
  return readFileSync("LemmaScript-files.txt", "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
    .map(entry => {
      const [file, second, ...rest] = entry.split(/\s+/);
      const timeout = second && /^[1-9]\d*$/.test(second) ? parseInt(second) : undefined;
      const flags = (timeout === undefined ? [second, ...rest] : rest).filter(Boolean).join(" ") || undefined;
      return { file, timeout, flags };
    });
}

function effectiveOptions(
  sourcePath: string,
  sourceText: string,
  configPath?: string,
): { options: LscOptions; configFile: string | null } {
  const loaded = loadConfigOptions(sourcePath, configPath);
  const fileOptions = parseFileOptions(sourceText, sourcePath);
  const options = resolveOptions({ ...loaded.explicit, ...fileOptions }, sourcePath);
  return { options, configFile: loaded.configFile };
}

/** Imported contracts must retain the string model used by their source files. */
function stringModelValidator(source: SourceFile, options: LscOptions, configPath?: string): (source: SourceFile) => void {
  const seen = new Set<SourceFile>();
  return start => {
    const pending = [start];
    while (pending.length > 0) {
      const dependency = pending.pop()!;
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      pending.push(...dependency.getReferencedSourceFiles());
      // Declaration files describe host APIs; follow re-exports through them,
      // but compare models only for source files that can carry verified code.
      if (dependency === source || dependency.isDeclarationFile()) continue;
      const { options: imported } = effectiveOptions(dependency.getFilePath(), dependency.getFullText(), configPath);
      if (imported["string-semantics"] !== options["string-semantics"]) {
        throw new Error(`${source.getFilePath()}: string-semantics=${options["string-semantics"]} differs from `
          + `${dependency.getFilePath()} (string-semantics=${imported["string-semantics"]}); `
          + "use the same string model across source dependencies");
      }
    }
  };
}

/** `lsc config [file.ts]` — report discovery, effective values, and routing. */
function runConfig(filePath: string | undefined, configPath?: string): void {
  if (!filePath) {
    // loadConfigOptions starts discovery at a source file's parent, so use a
    // synthetic path under cwd for the directory-oriented command form.
    const probe = path.join(process.cwd(), ".lemmascript-config-probe.ts");
    const loaded = loadConfigOptions(probe, configPath);
    const options = resolveOptions(loaded.explicit, loaded.configFile ?? process.cwd());
    console.log(JSON.stringify({ configFile: loaded.configFile, options }, null, 2));
    return;
  }

  const sourcePath = path.resolve(filePath);
  if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
  const sourceText = readFileSync(sourcePath, "utf8");
  const { options, configFile } = effectiveOptions(sourcePath, sourceText, configPath);
  const artifactDir = resolveDafnyArtifactDir(sourcePath, configFile, options);
  console.log(JSON.stringify({ configFile, options, artifactDir }, null, 2));
}

// Batch over LemmaScript-files.txt. Without --slow or an explicit --time-limit,
// Dafny check entries with manifest timeouts above 60s run gen-check only.
// Fail-fast: the first failing entry exits.
function runBatch(
  cmd: string,
  backend: "lean" | "dafny",
  slow: boolean,
  timeLimit?: number,
  extraFlags?: string,
  configPath?: string,
) {
  if (cmd !== "gen" && cmd !== "gen-check" && cmd !== "check") {
    console.error(`No file given, and batch mode supports gen|gen-check|check (not ${cmd}).`);
    process.exit(1);
  }
  const verifySlow = slow || timeLimit !== undefined;
  for (const e of readEntries()) {
    const timeout = timeLimit ?? e.timeout;
    const flags = extraFlags ?? e.flags;
    if (cmd === "check" && backend === "dafny" && !verifySlow && timeout !== undefined && timeout > 60) {
      console.log(`=== ${path.basename(e.file)} (timeout ${timeout}s > 60s, gen-check only) ===`);
      runFile("gen-check", e.file, backend, undefined, undefined, false, false, configPath);
    } else {
      runFile(cmd, e.file, backend, timeout, flags, false, false, configPath);
    }
  }
}

function guardRelocatedDafnyProof(
  sourceDir: string,
  artifactDir: string,
  base: string,
  targetDfyPath: string,
): void {
  if (path.resolve(sourceDir) === path.resolve(artifactDir) || existsSync(targetDfyPath)) return;
  const legacyPaths = [
    path.join(sourceDir, `${base}.dfy`),
    path.join(sourceDir, `${base}.dfy.base`),
    path.join(sourceDir, `${base}.dfy.merged`),
  ].filter(existsSync);
  if (legacyPaths.length === 0) return;

  throw new Error(
    `proof-dir maps '${base}' to ${artifactDir}, but existing proof state would be left behind:\n` +
    legacyPaths.map(p => `  ${p}`).join("\n") +
    `\nMove the hand-written .dfy to ${targetDfyPath}, inspect or remove stale .dfy.base/.dfy.merged files, then rerun. The .dfy.gen file is regeneratable.`,
  );
}

function runFile(
  cmd: string,
  filePath: string,
  backend: "lean" | "dafny",
  timeLimit: number | undefined,
  extraFlags: string | undefined,
  noVerify = false,
  typedInfo = false,
  configPath?: string,
) {
  const absPath = path.resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  // Find nearest tsconfig.json for import resolution; fall back to bare options
  const tsConfigFilePath = findUp("tsconfig.json", absPath) ?? undefined;
  const project = tsConfigFilePath
    ? new Project({ tsConfigFilePath })
    : new Project({ compilerOptions: { strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"] } });
  const sourceFile = project.addSourceFileAtPath(absPath);
  project.resolveSourceFileDependencies();
  // Foldkit message unions are read as `_tag` unions in this file and every module it imports (message-union.ts).
  const seen = new Set<SourceFile>();
  const desugar = (file: SourceFile): void => {
    if (seen.has(file) || file.isInNodeModules() || file.isDeclarationFile()) return;
    seen.add(file);
    desugarMessageUnions(file);
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const imported = declaration.getModuleSpecifierSourceFile();
      if (imported) desugar(imported);
    }
  };
  desugar(sourceFile);

  const fullText = sourceFile.getFullText();
  const { options, configFile } = effectiveOptions(absPath, fullText, configPath);
  // Checked here, for every command, so a bad LSC_RUN_LOG fails like a bad config value.
  const runLogOn = runLogEnabled(options["run-log"], process.env.LSC_RUN_LOG);

  // Check //@ backend directive — skip if backend doesn't match.
  // `extract` and `info` are backend-neutral and always run.
  const backendDirective = fullText.match(/\/\/@ backend (\w+)/);
  if (cmd !== "extract" && cmd !== "info" && backendDirective && backendDirective[1] !== backend) {
    console.log(`Skipped: ${path.basename(filePath)} (//@ backend ${backendDirective[1]}, current: ${backend})`);
    return;
  }

  // `//@ lean-module <name>` overrides the Lean module base (default: file
  // basename). Lean module names are flat/global, so two identically-named
  // `.ts` files (e.g. an in-place fork's duplicated `compaction.ts`) would emit
  // colliding `foo.types`/`foo.def` modules; this gives one a distinct base so
  // both can be separate Lean libraries. Lean-only — Dafny is unaffected.
  const leanModuleDirective = fullText.match(/\/\/@ lean-module ([A-Za-z0-9_.\-]+)/);
  const leanModuleOverride = leanModuleDirective ? leanModuleDirective[1] : undefined;

  // Validate the actual dependency graph, not unrelated files in the tsconfig.
  // Library selection may differ; only the string model changes contract meaning.
  const validateDependency = stringModelValidator(sourceFile, options, configPath);
  validateDependency(sourceFile);

  // Extract: ts-morph → Raw IR
  const raw = extractModule(sourceFile, options, validateDependency);

  if (cmd === "extract") {
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  if (cmd === "info" && !typedInfo) {
    const outPath = path.join(path.dirname(absPath), `${path.basename(filePath, ".ts")}.ts.json`);
    runInfo(raw, outPath);
    return;
  }

  // Resolve: Raw IR → Typed IR
  const resolved = resolveModule(raw);
  // Narrow: Typed IR → Typed IR (rewrites optional-narrowing patterns to someMatch)
  // auto-havoc (//@ autohavoc): replace unmodellable expressions with arbitrary
  // values so verification rests only on the declared contracts (a sound
  // over-approximation). No-op unless a function opts in.
  const typed = autoHavocModule(narrowModule(resolved));

  if (cmd === "info") {
    // --typed: the satellite contract. Run an in-memory Dafny emission purely
    // to harvest the emitted-name map; the file is backend-neutral otherwise,
    // so a failure here (e.g. Lean-only constructs) degrades to an error note
    // rather than failing the command.
    let dafnyInfo: TypedInfoDafny;
    try {
      let { typesFile, defFile } = transformModuleDafny(typed);
      if (typesFile) typesFile = peepholeModule(typesFile, "dafny");
      defFile = peepholeModule(defFile, "dafny");
      const merged = { ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] };
      emitDafnyFile(merged, path.basename(filePath), options);
      dafnyInfo = { emittedNames: Object.fromEntries(emittedNameMap()) };
    } catch (err) {
      dafnyInfo = { error: err instanceof Error ? err.message : String(err) };
    }
    runTypedInfo(raw, typed, lscVersion(), backendDirective ? backendDirective[1] : null, options, dafnyInfo);
    return;
  }

  const dir = path.dirname(absPath);
  const base = path.basename(filePath, ".ts");

  // ── Dafny backend ─────────────────────────────────────────
  if (backend === "dafny") {
    let { typesFile, defFile } = transformModuleDafny(typed);
    if (typesFile) typesFile = peepholeModule(typesFile, "dafny");
    defFile = peepholeModule(defFile, "dafny");
    const allDecls = [...(typesFile?.decls ?? []), ...defFile.decls];
    const merged = { ...defFile, decls: allDecls };
    const text = emitDafnyFile(merged, path.basename(filePath), options);
    const artifactDir = resolveDafnyArtifactDir(absPath, configFile, options);
    const genPath = path.join(artifactDir, `${base}.dfy.gen`);
    const dfyPath = path.join(artifactDir, `${base}.dfy`);
    const basePath = path.join(artifactDir, `${base}.dfy.base`);

    guardRelocatedDafnyProof(dir, artifactDir, base, dfyPath);
    mkdirSync(artifactDir, { recursive: true });

    // Record check/regen runs in the run log. Created after the proof-dir guard
    // so an aborted run leaves no snapshot; each helper records the stage it detects.
    const logCmd = cmd === "check" || cmd === "regen" ? cmd : null;
    const log = logCmd && runLogOn
      ? new RunLog({ logDir: resolveLogDir(absPath, configFile), cmd: logCmd, sourcePath: absPath, extraFlags, lscVersion: safely(lscVersion) })
      : undefined;

    if (cmd === "gen") { dafnyGen(genPath, dfyPath, text); return; }
    if (cmd === "gen-check") {
      dafnyGen(genPath, dfyPath, text);
      if (!dafnyCheckDiff(genPath, dfyPath)) process.exit(1);
      return;
    }
    if (cmd === "check") {
      dafnyGen(genPath, dfyPath, text);
      if (!dafnyCheckDiff(genPath, dfyPath, log)) process.exit(1);
      if (!dafnyVerify(dfyPath, artifactDir, timeLimit, extraFlags, log)) process.exit(1);
      return;
    }
    if (cmd === "regen") { dafnyRegen(genPath, dfyPath, basePath, text, artifactDir, timeLimit, extraFlags, noVerify, log); return; }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }

  // ── Lean backend ──────────────────────────────────────────
  // Dafny-only profile: Lean's `String` is a sequence of Unicode scalars and
  // LemmaScript has no UTF-16 encoding for it (DESIGN_STRINGS.md §4). Refuse
  // rather than emit scalar Lean for a code-unit claim.
  if (options["string-semantics"] === "javascript-utf16") {
    console.error('ERROR: "string-semantics": "javascript-utf16" is not available for --backend=lean; use --backend=dafny or select "unicode-scalar" in lemmascript.json or a //@ option directive.');
    process.exit(1);
  }
  const leanBase = leanModuleOverride ?? base;
  const specPath = path.join(dir, `${leanBase}.spec.lean`);
  const specImport = existsSync(specPath) ? `«${leanBase}.spec»` : undefined;
  let { typesFile, defFile } = transformModuleLean(typed, specImport, leanModuleOverride);
  if (typesFile) typesFile = peepholeModule(typesFile, "lean");
  defFile = peepholeModule(defFile, "lean");

  resetLeanModule();  // clear per-module emitter state so batch mode doesn't leak into this module
  const typesPath = typesFile ? path.join(dir, `${leanBase}.types.lean`) : null;
  const typesText = typesFile ? emitLeanFile(typesFile) : null;
  const defPath = path.join(dir, `${leanBase}.def.lean`);
  const defText = emitLeanFile(defFile);

  if (cmd === "gen") { leanGen(typesPath, defPath, typesText, defText); return; }
  if (cmd === "check") {
    leanGen(typesPath, defPath, typesText, defText);
    if (!leanCheck(dir, leanBase)) process.exit(1);
    return;
  }
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
