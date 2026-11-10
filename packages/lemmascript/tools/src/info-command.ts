/**
 * `lsc info` — emit a JSON summary of verified functions in a TS file.
 *
 * Pipeline: extract only (no resolve/transform/emit). Walks Raw IR for
 * top-level functions and class methods, preserving the original `//@ `
 * source text for clauses (no specparser round-trip).
 *
 * Output: `foo.ts.json` next to `foo.ts`, with shape:
 *   { method: { sig, requires, ensures, decreases }, ... }
 * Class methods key as `ClassName.method`.
 */

import { writeFileSync } from "fs";
import type { RawFunction, RawModule } from "./rawir.js";
import type { TFunction, TModule } from "./typedir.js";
import { parseTsType, tyToCanonical } from "./types.js";
import type { LscOptions } from "./config.js";

interface FnInfo {
  sig: string;
  requires: string[];
  ensures: string[];
  decreases: string | null;
}

function renderSig(fn: RawFunction): string {
  const params = fn.params.map(p => `${p.name}: ${tyToCanonical(parseTsType(p.tsType))}`).join(", ");
  return `(${params}): ${tyToCanonical(parseTsType(fn.returnType))}`;
}

function fnToInfo(fn: RawFunction): FnInfo {
  return {
    sig: renderSig(fn),
    requires: fn.requires,
    ensures: fn.ensures,
    decreases: fn.decreases,
  };
}

export function runInfo(raw: RawModule, outPath: string): void {
  const out: Record<string, FnInfo> = {};
  for (const fn of raw.functions) {
    out[fn.name] = fnToInfo(fn);
  }
  for (const cls of raw.classes) {
    for (const m of cls.methods) {
      out[`${cls.name}.${m.name}`] = fnToInfo(m);
    }
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

// ── `lsc info --typed` ───────────────────────────────────────
//
// Machine-readable contract for satellites (lemmascript-crosscheck): the
// resolved Typed IR's signatures, spec ASTs, and flags — everything a tool
// needs to derive generators and classify functions without importing the
// pipeline. Printed to stdout (like `lsc extract`), versioned by `schema`.

export interface TypedInfoDafny {
  /** Source name → emitted Dafny name, from an in-memory Dafny emission. */
  emittedNames?: Record<string, string>;
  /** Present when the Dafny emission failed (e.g. Lean-only constructs). */
  error?: string;
}

/** Statement/expression kinds present anywhere in a function body — a cheap
 *  structural census so consumers can classify (havoc/assume/throw usage)
 *  without receiving the whole body. */
function bodyKinds(fn: TFunction): string[] {
  // Keys under which a Ty (not a statement/expression) hangs — their `kind`
  // tags belong to the type grammar and would pollute the census.
  const TY_KEYS = new Set(["ty", "binderTy", "varTy", "nameTypes"]);
  const kinds = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.kind === "string") {
        kinds.add(o.kind === "assert" && o.assumed === true ? "assume" : o.kind);
      }
      for (const [k, v] of Object.entries(o)) if (!TY_KEYS.has(k)) walk(v);
    }
  };
  walk(fn.body);
  return [...kinds].sort();
}

function typedFn(fn: TFunction, rawFn: RawFunction | undefined) {
  // Carry the original TS type string per parameter: Ty conflates types whose
  // runtime shapes differ (Map<K,V> and Record<K,V> both map to kind "map"),
  // and satellites that construct runtime values need to tell them apart.
  const rawTsTypes = new Map((rawFn?.params ?? []).map(p => [p.name, p.tsType]));
  return {
    name: fn.name,
    exported: rawFn?.exported ?? false,
    typeParams: fn.typeParams,
    params: fn.params.map(p => ({ ...p, tsType: rawTsTypes.get(p.name) })),
    returnTy: fn.returnTy,
    requires: fn.requires,
    ensures: fn.ensures,
    decreases: fn.decreases,
    contract: rawFn?.contract ?? [],
    isPure: fn.isPure,
    forcePure: fn.forcePure,
    autohavoc: fn.autohavoc,
    bodyKinds: bodyKinds(fn),
  };
}

export function runTypedInfo(
  raw: RawModule,
  typed: TModule,
  version: string,
  backendDirective: string | null,
  options: LscOptions,
  dafny: TypedInfoDafny,
): void {
  const rawByName = new Map(raw.functions.map(f => [f.name, f]));
  const rawMethods = new Map(
    raw.classes.flatMap(c => c.methods.map(m => [`${c.name}.${m.name}`, m] as const)));
  const out = {
    schema: 1,
    lemmascript: version,
    file: typed.file,
    backendDirective,
    options,
    typeDecls: typed.typeDecls,
    externs: typed.externs,
    constants: typed.constants,
    functions: typed.functions.map(f => typedFn(f, rawByName.get(f.name))),
    classes: typed.classes.map(c => ({
      name: c.name,
      fields: c.fields,
      methods: c.methods.map(m => typedFn(m, rawMethods.get(`${c.name}.${m.name}`))),
    })),
    dafny,
  };
  console.log(JSON.stringify(out, null, 2));
}
