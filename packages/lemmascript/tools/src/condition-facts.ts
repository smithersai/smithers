/**
 * condition-facts — what a condition establishes (DESIGN_LS_IN_LS.md §4).
 *
 * One module owns condition semantics: detecting the facts a condition
 * establishes (optional presence, discriminant variants, synth array-union
 * branches, `||`-chain None-detectors, in-bounds) and materializing them as
 * IR (`someMatch` / `tagMatch` / bounds conditionals). `narrow`'s rules are
 * positional drivers over these helpers; `resolve` consults the same
 * detection for branch typing.
 *
 * Analysis shape: a condition yields ONE leading fact plus a residual
 * condition (`leadingPresent` on `&&`-chains); nesting comes from the
 * drivers re-walking the residual, so recursion order carries the
 * dependency between chained facts (`x !== undefined && x.f !== undefined`
 * reifies the second check inside the match introduced by the first). This
 * realizes §4's ordered-fact list iteratively rather than as a returned
 * list — same semantics, no intermediate structure.
 *
 * State is explicit (§6.1): detection that mints binders or consults type
 * declarations takes a `CondCtx`; nothing module-level.
 */

import type { TExpr, TStmt, Ty } from "./typedir.js";
import { freshName, freshNameWhere, isUserName } from "./names.js";
import type { TypeDecls } from "./typedecls.js";
import { unionDeclOfTy, discriminantOf } from "./typedecls.js";

/** Explicit context: declarations, optChain counter, and scope-local binders. */
export interface CondCtx {
  decls: TypeDecls;
  oc: { n: number };
  binders?: { names: Map<string, string>; used: Set<string> };
}

/** Allocate within this context, retaining a path's name on repeated
 *  detection. Semantic-only callers need no registry. */
function freshBinder(ctx: CondCtx, hint: string, key?: string): string {
  const names = ctx.binders ??= { names: new Map(), used: new Set() };
  const existing = key === undefined ? undefined : names.names.get(key);
  if (existing !== undefined) return existing;
  const binder = freshNameWhere(hint, name => isUserName(name) || names.used.has(name));
  names.used.add(binder);
  if (key !== undefined) names.names.set(key, binder);
  return binder;
}

export function freshOcBinder(ctx: CondCtx): string {
  return freshBinder(ctx, `_oc${ctx.oc.n++}_val`);
}

// ── Presence facts ──────────────────────────────────────────

/** What an optional check establishes: `scrutinee` is present (or absent,
 *  when `negated`), binding `binder : innerTy`. `binder` is a
 *  source-safe hint during detection; materializers freshen it against the
 *  context's other binders. `truthiness` marks the `if (o)` / `!o` / `o ? :`
 *  forms, where presence alone isn't enough — a falsy inner value (`Some(0)`,
 *  `Some("")`) must still fail the check. */
export interface PresentFact {
  scrutinee: TExpr;
  innerTy: Ty;
  negated: boolean;
  binder: string;
  truthiness: boolean;
}

/** Pure access paths: the raw var root followed by its field names;
 *  null for non-path shapes. */
function pathParts(e: TExpr): string[] | null {
  const fields: string[] = [];
  let cur = e;
  while (cur.kind === "field") { fields.unshift(cur.field); cur = cur.obj; }
  if (cur.kind !== "var") return null;
  return [cur.name, ...fields];
}

export function binderHintFor(e: TExpr): string | null {
  const parts = pathParts(e);
  if (!parts) return null;
  // \result is stored as the IR var name "\\result"; sanitize for a valid identifier.
  const root = parts[0] === "\\result" ? "result" : parts[0];
  return `_${[root, ...parts.slice(1)].join("_")}_val`;
}

/** The hint is deliberately readable, not a path identity: `a_b` and `a.b`
 *  share it. Key the allocation by the complete path instead. */
export function freshPathBinder(e: TExpr, ctx: CondCtx): string | null {
  const hint = binderHintFor(e);
  return hint === null ? null : freshBinder(ctx, hint, JSON.stringify(["path", ...pathParts(e)!]));
}

export function bindPresentFact(f: PresentFact, ctx: CondCtx): PresentFact {
  return { ...f, binder: freshPathBinder(f.scrutinee, ctx)! };
}

/** Detect optional checks: `e !== undefined`, `e === undefined`, `!e`, or a
 *  bare optional `e` — for a pure-access-path optional-typed `e`. `!e` and
 *  bare `e` are truthiness forms. Following TS, only pure access paths
 *  narrow; complex scrutinees return null. */
export function presentFact(cond: TExpr): PresentFact | null {
  // `!e` where e is optional — a truthiness form: false iff e is absent OR its
  // inner value is itself falsy (so `Some(0)`/`Some("")` count as falsy too).
  if (cond.kind === "unop" && cond.op === "!" && cond.expr.ty.kind === "optional") {
    const e = cond.expr;
    const innerTy = cond.expr.ty.inner;
    const hint = binderHintFor(e);
    if (hint === null) return null;
    return { scrutinee: e, innerTy, negated: true, binder: freshName(hint), truthiness: true };
  }
  if (cond.kind !== "binop" || (cond.op !== "!==" && cond.op !== "===")) {
    // Bare optional truthiness: `if (e)` where e: T | undefined — true iff e is
    // present AND its inner value is truthy.
    if (cond.ty.kind === "optional") {
      const hint = binderHintFor(cond);
      if (hint === null) return null;
      return { scrutinee: cond, innerTy: cond.ty.inner, negated: false, binder: freshName(hint), truthiness: true };
    }
    return null;
  }
  // Explicit `e === undefined` / `e !== undefined` — a pure presence check,
  // independent of the inner value (so NOT a truthiness form).
  let e: TExpr | null = null;
  if (cond.right.kind === "var" && cond.right.name === "undefined") e = cond.left;
  if (cond.left.kind === "var" && cond.left.name === "undefined") e = cond.right;
  if (!e || e.ty.kind !== "optional") return null;
  const hint = binderHintFor(e);
  if (hint === null) return null;
  return { scrutinee: e, innerTy: e.ty.inner, negated: cond.op === "===", binder: freshName(hint), truthiness: false };
}

/** Which types have falsy values in JS (`0`, `""`, `false`); everything else
 *  (array, user type, …) is always truthy. The single home of that set —
 *  transform's `valueTruthyCond` gates on it too. */
export const isFalsyCapableTy = (ty: Ty): boolean =>
  ["int", "nat", "string", "bool"].includes(ty.kind);

// `Some(0)` / `Some("")` / `Some(false)` are falsy, so a truthiness check
// (`if (o)`, `!o`, `o ? :`) over a nullable primitive must still test the bound
// value. Nullable objects/arrays are always truthy, and `!== undefined` is a pure
// presence check — neither needs the gate.
export const canBeFalsy = (f: PresentFact): boolean =>
  f.truthiness && isFalsyCapableTy(f.innerTy);
export const bound = (f: PresentFact): TExpr =>
  ({ kind: "var", name: f.binder, ty: f.innerTy });

// ── `&&`-chain analysis: one leading fact + residual ────────

/** Pull one `parse`-matching conjunct out of an `&&` tree, returning it plus
 *  the tree with that conjunct removed:
 *  `(x !== undefined && b) && c` → { check, restCond: b && c }.
 *
 *  Search matching conjuncts in source order. A later check may read a field
 *  whose root an earlier check unwraps, so the left subtree must be searched
 *  before the right operand. Keep the remaining conjuncts in their original
 *  relative order. */
export function extractConjunct<C>(cond: TExpr, parse: (e: TExpr) => C | null): { check: C; restCond: TExpr } | null {
  if (cond.kind !== "binop" || cond.op !== "&&") return null;
  const left = parse(cond.left);
  if (left) return { check: left, restCond: cond.right };
  if (cond.left.kind === "binop" && cond.left.op === "&&") {
    const inner = extractConjunct(cond.left, parse);
    if (inner) return { check: inner.check, restCond: { ...cond, left: inner.restCond } as TExpr };
  }
  const right = parse(cond.right);
  if (right) return { check: right, restCond: cond.left };
  if (cond.right.kind === "binop" && cond.right.op === "&&") {
    const inner = extractConjunct(cond.right, parse);
    if (inner) return { check: inner.check, restCond: { ...cond, right: inner.restCond } as TExpr };
  }
  return null;
}

/** The first positive presence fact in source order, plus the residual.
 *  It becomes the outermost match, keeping later path checks in its arm. */
export function leadingPresent(cond: TExpr): { check: PresentFact; restCond: TExpr } | null {
  return extractConjunct(cond, e => {
    const f = presentFact(e);
    return f && !f.negated ? f : null;
  });
}

// ── `||`-chain analysis (De Morgan): None-detectors ─────────

/** Flatten a nested `||` chain into its leaf conditions. */
export function flattenOr(e: TExpr): TExpr[] {
  if (e.kind === "binop" && e.op === "||") return [...flattenOr(e.left), ...flattenOr(e.right)];
  return [e];
}

/** A `||` disjunct that `x === None` makes true (so if every disjunct is false,
 *  `x` is Some). `residual` is the guard it still contributes once `x` is Some
 *  (`!v` for a falsy-capable `!x`; `v.chain !== lit` for an optchain compare;
 *  null otherwise). */
export type NoneDetector = { scrutinee: TExpr; innerTy: Ty; binder: string; residual: TExpr | null };

export function noneDetector(leaf: TExpr, ctx: CondCtx): NoneDetector | null {
  // `x?.chain !== lit` — `undefined !== lit` is true when x is None.
  if (leaf.kind === "binop" && leaf.op === "!==") {
    const oc = leaf.left.kind === "optChain" ? leaf.left : leaf.right.kind === "optChain" ? leaf.right : null;
    if (oc && oc.kind === "optChain" && oc.obj.ty.kind === "optional") {
      const binder = freshPathBinder(oc.obj, ctx);
      if (binder === null) return null;
      const unwrapped = applyChain({ kind: "var", name: binder, ty: oc.obj.ty.inner }, oc.chain);
      restoreDiscriminantFlag(unwrapped, ctx.decls);
      const lit = leaf.left === oc ? leaf.right : leaf.left;
      return { scrutinee: oc.obj, innerTy: oc.obj.ty.inner, binder, residual: { kind: "binop", op: "!==", left: unwrapped, right: lit, ty: { kind: "bool" } } };
    }
  }
  // `!x` / `x === undefined`.
  const detected = presentFact(leaf);
  if (detected && detected.negated) {
    const f = bindPresentFact(detected, ctx);
    const residual: TExpr | null = canBeFalsy(f)
      ? { kind: "unop", op: "!", expr: { kind: "var", name: f.binder, ty: f.innerTy }, ty: { kind: "bool" } }
      : null;
    return { scrutinee: f.scrutinee, innerTy: f.innerTy, binder: f.binder, residual };
  }
  return null;
}

// ── Optional chains ─────────────────────────────────────────

type OptChain = Extract<TExpr, { kind: "optChain" }>;

/** Apply an optional chain's steps (field / index / call) to a base expr. */
export function applyChain(body: TExpr, chain: OptChain["chain"]): TExpr {
  for (const step of chain) {
    if (step.kind === "field") body = { kind: "field", obj: body, field: step.name, ty: step.ty };
    else if (step.kind === "index") body = { kind: "index", obj: body, idx: step.idx, ty: step.ty };
    else body = { kind: "call", fn: body, args: step.args, ty: step.ty, callKind: step.callKind,
      ...(step.builtinId ? { builtinId: step.builtinId } : {}) };
  }
  return body;
}

/** `applyChain` rebuilds a field access without the `isDiscriminant` flag
 *  resolve sets on a direct `x.disc`; restore it when the unwrapped access
 *  is the binder union's discriminant, so the guard feeds discriminant
 *  narrowing. (The single home of a fixup formerly duplicated per rule.) */
export function restoreDiscriminantFlag(unwrapped: TExpr, decls: TypeDecls): void {
  if (unwrapped.kind === "field" &&
      discriminantOf(decls, unwrapped.obj.ty) === unwrapped.field) {
    unwrapped.isDiscriminant = true;
  }
}

// ── In-bounds facts ─────────────────────────────────────────

/** `0 <= idx && idx < arr.length` — the in-bounds guard for an array index. */
export function arrayBoundsCond(arr: TExpr, idx: TExpr): TExpr {
  const len: TExpr = { kind: "field", obj: arr, field: "length", ty: { kind: "int" } };
  const lo: TExpr = { kind: "binop", op: "<=", left: { kind: "num", value: 0, ty: { kind: "int" } }, right: idx, ty: { kind: "bool" } };
  const hi: TExpr = { kind: "binop", op: "<", left: idx, right: len, ty: { kind: "bool" } };
  return { kind: "binop", op: "&&", left: lo, right: hi, ty: { kind: "bool" } };
}

// ── Map-membership facts ────────────────────────────────────

/** Minimal structural equality on the IR shapes we narrow against: var, field
 *  chain, and index (with pure key). Enough to recognize `m[k]` on both sides
 *  of a `k in m ? m[k] : default` ternary. */
export function exprEqual(a: TExpr, b: TExpr): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "var" && b.kind === "var") return a.name === b.name;
  if (a.kind === "field" && b.kind === "field")
    return a.field === b.field && exprEqual(a.obj, b.obj);
  if (a.kind === "index" && b.kind === "index")
    return exprEqual(a.obj, b.obj) && exprEqual(a.idx, b.idx);
  return false;
}

/** Produce a reader-friendly binder hint for `m[k]` when both m and k are
 *  access-path shaped (var / field chain). Falls back to a generic counter
 *  name for computed keys. */
export function binderHintForMapAccess(m: TExpr, k: TExpr, ctx: CondCtx): string {
  const mHint = binderHintFor(m);
  const kHint = binderHintFor(k);
  if (mHint && kHint) {
    // mHint is `_m_val`, kHint is `_k_val` — stitch into `_m_k_val`.
    const mStem = mHint.replace(/_val$/, "");
    const kStem = kHint.replace(/^_/, "").replace(/_val$/, "");
    return freshBinder(ctx, `${mStem}_${kStem}_val`, JSON.stringify(["map", pathParts(m), pathParts(k)]));
  }
  return freshOcBinder(ctx);
}

// ── Variant facts (discriminants and synth array-unions) ────

export interface VariantFact {
  scrutinee: TExpr & { kind: "var" };
  typeName: string;
  variant: string;
}

export interface IsArrayFact {
  scrutinee: TExpr;
  typeName: string;
  variant: "ArrayBranch" | "NonArrayBranch";
}

/** A "narrowable path" is a var or a chain of field accesses rooted at a var
 *  — i.e., pure and structurally addressable, so transforms can substitute
 *  occurrences inside a matched arm without worrying about re-evaluation. */
export function isNarrowablePath(e: TExpr): boolean {
  if (e.kind === "var") return true;
  if (e.kind === "field") return isNarrowablePath(e.obj);
  return false;
}

/** Detect `Array.isArray(<path>)` where `<path>` is a narrowable path whose
 *  type is a synthesized array-union (discriminant `"__isArray__"`). */
export function isArrayFact(call: TExpr, ctx: CondCtx): (IsArrayFact & { variant: "ArrayBranch" }) | null {
  if (call.kind !== "call") return null;
  if (call.fn.kind !== "field" || call.fn.field !== "isArray") return null;
  if (call.fn.obj.kind !== "var" || call.fn.obj.name !== "Array") return null;
  if (call.args.length !== 1) return null;
  const arg = call.args[0];
  if (!isNarrowablePath(arg) || arg.ty.kind !== "user") return null;
  const decl = unionDeclOfTy(ctx.decls, arg.ty);
  if (decl?.discriminant !== "__isArray__") return null;
  return { scrutinee: arg, typeName: arg.ty.name, variant: "ArrayBranch" };
}

/** Detect `typeof <path> === "string"` where `<path>`'s type is a synth array-
 *  union (`U | T[]`) AND its `NonArrayBranch` payload `U` is itself `string`.
 *  The runtime `=== "string"` test matches that branch only when `U` is string —
 *  for any other non-array payload (`number | T[]`, …) it never holds, so we must
 *  NOT narrow. Returns the `NonArrayBranch` variant; the dual of `Array.isArray`. */
export function typeofStringFact(e: TExpr, ctx: CondCtx): (IsArrayFact & { variant: "NonArrayBranch" }) | null {
  if (e.kind !== "binop" || e.op !== "===") return null;
  const tof = e.left.kind === "unop" && e.left.op === "typeof" ? e.left.expr
    : e.right.kind === "unop" && e.right.op === "typeof" ? e.right.expr : null;
  const lit = e.left.kind === "str" ? e.left.value : e.right.kind === "str" ? e.right.value : null;
  if (!tof || lit !== "string") return null;
  if (!isNarrowablePath(tof) || tof.ty.kind !== "user") return null;
  const decl = unionDeclOfTy(ctx.decls, tof.ty);
  if (decl?.discriminant !== "__isArray__") return null;
  const valTy = decl.variants?.find(v => v.name === "NonArrayBranch")?.fields.find(f => f.name === "val")?.type;
  if (valTy?.kind !== "string") return null;   // guard: the non-array branch must actually be `string`
  return { scrutinee: tof, typeName: tof.ty.name, variant: "NonArrayBranch" };
}

/** Leading `Array.isArray(path)` fact of an `&&` chain (positive form only — a
 *  negated `!Array.isArray(...)` would narrow to the wrong variant for then-body
 *  consumers, so those are left to the untouched-conditional path). */
export function leadingIsArray(cond: TExpr, ctx: CondCtx) {
  return extractConjunct(cond, e => isArrayFact(e, ctx));
}

/** Detect `x.kind === "variant"`, `'key' in x`, or `Array.isArray(x)` (synth
 *  array-union) as a positive discriminant check on a bare-var scrutinee. */
export function variantFact(cond: TExpr, ctx: CondCtx): VariantFact | null {
  // Pattern: x.discriminant === "variant"
  if (cond.kind === "binop" && cond.op === "===" && cond.right.kind === "str" &&
      cond.left.kind === "field" && cond.left.isDiscriminant &&
      cond.left.obj.kind === "var" && cond.left.obj.ty.kind === "user") {
    return { scrutinee: cond.left.obj, typeName: cond.left.obj.ty.name, variant: cond.right.value };
  }
  // Pattern: 'key' in x — narrows x to the unique variant containing `key`.
  if (cond.kind === "binop" && cond.op === "in" &&
      cond.left.kind === "str" && cond.right.kind === "var" &&
      cond.right.ty.kind === "user") {
    const key = cond.left.value;
    const typeName = cond.right.ty.name;
    const decl = unionDeclOfTy(ctx.decls, cond.right.ty);
    if (decl?.variants) {
      const matches = decl.variants.filter(v => v.fields.some(f => f.name === key));
      if (matches.length === 1) {
        return { scrutinee: cond.right, typeName, variant: matches[0].name };
      }
    }
  }
  // Pattern: Array.isArray(x) — narrows x to the ArrayBranch variant of a
  // synthesized array-union (discriminant "__isArray__"). Statement-level
  // discriminant chains (`if (Array.isArray(x)) {...} else if (...)`) still
  // require a bare-var scrutinee since the existing var-name-keyed
  // replacement machinery in transform.ts only handles that shape; path
  // scrutinees (e.g. `m.content`) are handled exclusively by the
  // conditional/expression tagMatch drivers.
  const arrCheck = isArrayFact(cond, ctx);
  if (arrCheck && arrCheck.scrutinee.kind === "var") {
    return { scrutinee: arrCheck.scrutinee, typeName: arrCheck.typeName, variant: arrCheck.variant };
  }
  return null;
}

/** Detect `x.kind !== "variant"` (negative discriminant check) or
 *  `!Array.isArray(x)` (synth array-union, narrows to NonArrayBranch). */
export function negVariantFact(cond: TExpr, ctx: CondCtx): VariantFact | null {
  if (cond.kind === "binop" && cond.op === "!==" && cond.right.kind === "str" &&
      cond.left.kind === "field" && cond.left.isDiscriminant &&
      cond.left.obj.kind === "var" && cond.left.obj.ty.kind === "user") {
    return { scrutinee: cond.left.obj, typeName: cond.left.obj.ty.name, variant: cond.right.value };
  }
  // Pattern: !Array.isArray(x) — narrows x to the NonArrayBranch variant.
  // Same var-scrutinee restriction as variantFact.
  if (cond.kind === "unop" && cond.op === "!") {
    const arrCheck = isArrayFact(cond.expr, ctx);
    if (arrCheck && arrCheck.scrutinee.kind === "var") {
      return { scrutinee: arrCheck.scrutinee, typeName: arrCheck.typeName, variant: "NonArrayBranch" };
    }
  }
  return null;
}

// ── Materializers ───────────────────────────────────────────

/** Reify a presence fact in statement position: the falsy gate (for
 *  truthiness checks over falsy-capable inners) tests the bound value inside
 *  the Some arm, routing falsy inners to `none`. */
export function presentMatchStmts(f: PresentFact, some: TStmt[], none: TStmt[], ctx: CondCtx): TStmt {
  f = bindPresentFact(f, ctx);
  return {
    kind: "someMatch",
    scrutinee: f.scrutinee, binderTy: f.innerTy,
    binder: f.binder,
    someBody: canBeFalsy(f) ? [{ kind: "if", cond: bound(f), then: some, else: none }] : some,
    noneBody: none,
  };
}

/** Reify a presence fact in expression position; same falsy gate. */
export function presentMatchExpr(f: PresentFact, some: TExpr, none: TExpr, ty: Ty, ctx: CondCtx): TExpr {
  f = bindPresentFact(f, ctx);
  return {
    kind: "someMatch",
    scrutinee: f.scrutinee, binderTy: f.innerTy,
    binder: f.binder,
    someBody: canBeFalsy(f) ? { kind: "conditional", cond: bound(f), then: some, else: none, ty } : some,
    noneBody: none,
    ty,
  };
}
