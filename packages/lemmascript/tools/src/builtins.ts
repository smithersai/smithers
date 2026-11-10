/**
 * Builtin registry — the single classification table for builtin methods on
 * collection/string receivers (DESIGN_LS_IN_LS.md §3).
 *
 * One stable `BuiltinId` per supported operation, one entry per identity.
 * `resolve` recognizes `(receiver type kind, method name)` once — via
 * `recognizeBuiltin` — and stamps the typed call node (and optChain call
 * steps) with the id. Downstream, `narrow` reads `pure` and `transform`
 * reads `hof`/`intArgPositions` from the stamp; neither re-recognizes by
 * spelling. The emitters are deliberately NOT keyed on the stamp: they
 * dispatch on `(objTy, method)` over the backend IR, where transform
 * legitimately synthesizes method calls with no source-level identity.
 *
 * The registry holds classification only — no lowerings. Namespace builtins
 * (`Math.*`, `Array.isArray`) are recognized syntactically in resolve and
 * are not registry entries: they are not methods on receiver values.
 *
 * Classification values mirror the historical per-pass lists exactly
 * (byte-for-byte gauntlet compatibility), including their quirks — e.g.
 * `array.shift` returns the element type un-wrapped and `array.with` types
 * as `unknown`. Widen such bits deliberately, with tests.
 */

import type { Ty, TExpr } from "./typedir.js";

export type RecvKind = "array" | "string" | "map" | "set";

export interface BuiltinSpec {
  /** Return-type rule. `inSpec` matters for `map.get` (raw value in specs,
   *  Option in code). */
  ret(objTy: Ty, args: TExpr[], c: { inSpec: boolean }): Ty;
  /** Lowers to a pure backend expression (`x in s`, `|s|`, `s.Keys`, …) —
   *  safe inside match arms even with `callKind: "method"`. */
  pure: boolean;
  /** Takes a lambda whose params are inferred from the receiver:
   *  unary (elem), comparator (elem, elem), reduce (acc, elem). */
  hof?: { shape: "unary" | "comparator" | "reduce" };
  /** Arg positions that must be nat in Lean (array index args). */
  intArgPositions?: number[];
  /** Arg 0 is a membership key/element of the receiver collection — drives
   *  quantifier-variable type inference (`forall k … m.has(k)`). */
  argIsKey?: boolean;
}

const UNKNOWN: Ty = { kind: "unknown" };
const BOOL = (): Ty => ({ kind: "bool" });
const INT = (): Ty => ({ kind: "int" });
const STRING = (): Ty => ({ kind: "string" });
const self = (objTy: Ty): Ty => objTy;
const elem = (objTy: Ty): Ty => objTy.kind === "array" ? objTy.elem : UNKNOWN;
const optElem = (objTy: Ty): Ty =>
  objTy.kind === "array" ? { kind: "optional", inner: objTy.elem } : UNKNOWN;

/** The table is the single source: each key is `<RecvKind>.<method>`, which
 *  *is* the `BuiltinId`. */
export const BUILTINS = {
  // ── array ─────────────────────────────────────────────────
  "array.includes": { ret: BOOL, pure: true,
    intArgPositions: [1], argIsKey: true },
  "array.indexOf": { ret: INT, pure: true,
    intArgPositions: [1] },
  "array.shift": { ret: elem, pure: false },
  "array.pop": { ret: optElem, pure: false },
  "array.push": { ret: self, pure: false },
  "array.unshift": { ret: self, pure: false },
  "array.concat": { ret: self, pure: true },
  "array.sort": { ret: self, pure: false,
    hof: { shape: "comparator" } },
  "array.filter": { ret: self, pure: false,
    hof: { shape: "unary" } },
  "array.every": { ret: BOOL, pure: false,
    hof: { shape: "unary" } },
  "array.some": { ret: BOOL, pure: false,
    hof: { shape: "unary" } },
  "array.reduce": { pure: false,
    hof: { shape: "reduce" },
    ret: (_objTy, args) => args.length === 2 ? args[1].ty : UNKNOWN },
  "array.find": { ret: optElem, pure: false,
    hof: { shape: "unary" } },
  "array.findLast": { ret: optElem, pure: false,
    hof: { shape: "unary" } },
  "array.findIndex": { ret: INT, pure: false,
    hof: { shape: "unary" } },
  "array.findLastIndex": { ret: INT,
    pure: false, hof: { shape: "unary" } },
  "array.flat": { pure: true,
    ret: (objTy) => objTy.kind === "array" && objTy.elem.kind === "array"
      ? { kind: "array", elem: objTy.elem.elem } : UNKNOWN },
  "array.slice": { ret: self, pure: true },
  "array.join": { pure: true,
    ret: (objTy) => objTy.kind === "array" && objTy.elem.kind === "string"
      ? STRING() : UNKNOWN },
  "array.map": { pure: false,
    hof: { shape: "unary" },
    // Prefer the lambda's declared return type (handles multi-statement bodies
    // where body[0] is an `if`, not a `return`); fall back to the body's return.
    ret: (_objTy, args) => {
      if (args.length >= 1 && args[0].kind === "lambda") {
        const lam = args[0];
        const retTy: Ty = lam.ty.kind === "fn" ? lam.ty.result
          : lam.body.length > 0 && lam.body[0].kind === "return" ? lam.body[0].value.ty : UNKNOWN;
        return { kind: "array", elem: retTy };
      }
      return UNKNOWN;
    } },
  "array.with": { ret: () => UNKNOWN, pure: true,
    intArgPositions: [0] },

  // ── string ────────────────────────────────────────────────
  "string.trim": { ret: STRING, pure: true },
  "string.trimEnd": { ret: STRING, pure: true },
  "string.trimStart": { ret: STRING, pure: true },
  "string.toLowerCase": { ret: STRING, pure: true },
  "string.toUpperCase": { ret: STRING, pure: true },
  "string.repeat": { ret: STRING, pure: true },
  "string.slice": { ret: STRING, pure: true },
  "string.substring": { ret: STRING, pure: true },
  "string.split": { pure: true,
    ret: () => ({ kind: "array", elem: { kind: "string" } }) },
  "string.includes": { ret: BOOL, pure: true },
  "string.startsWith": { ret: BOOL, pure: true },
  "string.endsWith": { ret: BOOL, pure: true },

  // ── map ───────────────────────────────────────────────────
  "map.get": { pure: true, argIsKey: true,
    ret: (objTy, _args, c) => objTy.kind !== "map" ? UNKNOWN
      : c.inSpec ? objTy.value : { kind: "optional", inner: objTy.value } },
  "map.has": { ret: BOOL, pure: true, argIsKey: true },
  "map.set": { ret: self, pure: false },
  "map.delete": { ret: self, pure: false },
  "map.keys": { ret: () => UNKNOWN, pure: true },
  "map.values": { ret: () => UNKNOWN, pure: true },

  // ── set ───────────────────────────────────────────────────
  "set.has": { ret: BOOL, pure: true, argIsKey: true },
  "set.add": { ret: self, pure: false },
  "set.delete": { ret: self, pure: false },
} satisfies Record<`${RecvKind}.${string}`, BuiltinSpec>;

/** One id per table entry. */
export type BuiltinId = keyof typeof BUILTINS;

/** Recognize a builtin method call by receiver type kind + method name.
 *  Called by resolve (once per call node); everything downstream reads the
 *  stamped id. `hasOwn`, not `in`: `method` comes from user source, and `in`
 *  would match inherited names (`constructor`, `toString`). */
export function recognizeBuiltin(objTy: Ty, method: string): BuiltinId | null {
  const k = objTy.kind;
  if (k !== "array" && k !== "string" && k !== "map" && k !== "set") return null;
  const id = `${k}.${method}`;
  return Object.hasOwn(BUILTINS, id) ? id as BuiltinId : null;
}

export function builtinSpec(id: BuiltinId): BuiltinSpec {
  return BUILTINS[id];
}
