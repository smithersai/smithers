/**
 * Transform — Typed IR → Backend IR.
 *
 * Consumes resolved types and classifications.
 * No type lookups, no string parsing, no re-inference.
 */

import type { TExpr, TStmt, TFunction, TModule, Ty } from "./typedir.js";
import { tyEqual } from "./typedir.js";
import type { Expr, Stmt, Decl, Module, FnDef, FnDefByMethod, FnMethod, MatchArm, StmtMatchArm, ConstDecl, MatchPattern } from "./ir.js";
import { anyExprInStmts, pWild, pCtor, pLiteral, patternBinders, patternBinds, patternCtor } from "./ir.js";
import type { TypeDeclInfo, VariantInfo } from "./types.js";
import { parseTsType } from "./types.js";
import { freshName } from "./names.js";
import { builtinSpec } from "./builtins.js";
import { isFalsyCapableTy } from "./condition-facts.js";
import { declOf, declOfKind, declOfTy, unionDeclOfTy, declWithVariant, tyBaseName } from "./typedecls.js";

// ── Generic IR walkers ──────────────────────────────────────

/**
 * Map over all sub-expressions in an Expr. `f` is called on each node;
 * if it returns non-null, that replaces the node (and recursion stops).
 * If it returns null, the walker recurses into children.
 */
function mapExpr(e: Expr, f: (e: Expr) => Expr | null): Expr {
  const hit = f(e);
  if (hit) return hit;
  const r = (x: Expr) => mapExpr(x, f);
  switch (e.kind) {
    case "var": case "num": case "bigint": case "bool": case "str": case "emptyMap": case "emptySet": case "havoc": case "default": return e;
    case "mapLiteral": return { ...e, entries: e.entries.map(en => ({ key: r(en.key), value: r(en.value) })) };
    case "constructor": return e.args ? { ...e, args: e.args.map(r) } : e;
    case "binop": return { ...e, left: r(e.left), right: r(e.right) };
    case "unop": return { ...e, expr: r(e.expr) };
    case "implies": return { ...e, premises: e.premises.map(r), conclusion: r(e.conclusion) };
    case "app": return { ...e, args: e.args.map(r) };
    case "field": return { ...e, obj: r(e.obj) };
    case "toNat": return { ...e, expr: r(e.expr) };
    case "toReal": return { ...e, expr: r(e.expr) };
    case "index": return { ...e, arr: r(e.arr), idx: r(e.idx) };
    case "tupleLiteral": return { ...e, elems: e.elems.map(r) };
    case "tupleProj": return { ...e, obj: r(e.obj) };
    case "record": return { ...e, spread: e.spread ? r(e.spread) : null, fields: e.fields.map(fi => ({ ...fi, value: r(fi.value) })) };
    case "arrayLiteral": return { ...e, elems: e.elems.map(r) };
    case "if": return { ...e, cond: r(e.cond), then: r(e.then), else: r(e.else) };
    case "match": {
      const scr = r(e.scrutinee);
      return { ...e, scrutinee: scr, arms: e.arms.map(a => ({ ...a, body: r(a.body) })) };
    }
    case "forall": return { ...e, body: r(e.body) };
    case "exists": return { ...e, body: r(e.body) };
    case "let": return { ...e, value: r(e.value), body: r(e.body) };
    case "methodCall": return { ...e, obj: r(e.obj), args: e.args.map(r) };
    case "lambda": return e;
  }
}

/** Map over all expressions in a statement tree. */
function mapStmt(s: Stmt, f: (e: Expr) => Expr | null): Stmt {
  const r = (e: Expr) => mapExpr(e, f);
  switch (s.kind) {
    case "let": return { ...s, value: r(s.value) };
    case "assign": return { ...s, value: r(s.value) };
    case "bind": return { ...s, value: r(s.value) };
    case "let-bind": return { ...s, value: r(s.value) };
    case "return": return { ...s, value: r(s.value) };
    case "break": case "continue": return s;
    case "if": return { ...s, cond: r(s.cond), then: s.then.map(t => mapStmt(t, f)), else: s.else.map(t => mapStmt(t, f)) };
    case "match": {
      const scr = r(s.scrutinee);
      return { ...s, scrutinee: scr, arms: s.arms.map(a => ({ ...a, body: a.body.map(t => mapStmt(t, f)) })) };
    }
    case "while": return { ...s, cond: r(s.cond), invariants: s.invariants.map(r), body: s.body.map(t => mapStmt(t, f)) };
    case "forin": return { ...s, bound: r(s.bound), invariants: s.invariants.map(r), body: s.body.map(t => mapStmt(t, f)) };
    case "ghostLet": return { ...s, value: r(s.value) };
    case "ghostAssign": return { ...s, value: r(s.value) };
    case "assert": return { ...s, expr: r(s.expr) };
  }
}

/** Rename free occurrences of `from` to `to`, stopping at every construct that
 *  rebinds `from` — lambda params, `let`/`let-bind`/`ghostLet` (shadows the
 *  rest of the block), `match` arm patterns, `forall`/`exists`, and `for-in`
 *  indices. Capture-avoiding: a nested scope that reintroduces `from` keeps its
 *  own binding untouched. `mapExpr` doesn't descend into lambda bodies, so this
 *  walks them by hand — statement binders are tracked only at that body's top
 *  level, which is enough for the sole caller (dafny-emit's
 *  `comprehensionBinder`). TODO: generalize if more callers need this. */
const varE = (name: string): Expr => ({ kind: "var", name });
export function renameFreeVar(e: Expr, from: string, to: string): Expr {
  const f = (x: Expr): Expr | null => {
    if (x.kind === "var") return x.name === from ? { ...x, name: to } : x;
    // let-expression: `value` is in the outer scope (rename), `body` sees the
    // rebound `from` (leave it), so handle the recursion here to stop descent.
    if (x.kind === "let" && x.name === from) return { ...x, value: mapExpr(x.value, f) };
    if ((x.kind === "forall" || x.kind === "exists") && x.var === from) return x;
    if (x.kind === "match") {
      return { ...x, scrutinee: mapExpr(x.scrutinee, f), arms: x.arms.map(a =>
        patternBinds(a.pattern, from) ? a : { ...a, body: mapExpr(a.body, f) }) };
    }
    if (x.kind === "lambda") {
      if (x.params.some(p => p.name === from)) return x;   // param shadows `from`
      const body: Stmt[] = [];
      let shadowed = false;
      for (const s of x.body) {
        if (shadowed) { body.push(s); continue; }
        body.push(s.kind === "forin" && s.idx === from
          ? { ...s, bound: mapExpr(s.bound, f) }            // idx shadows in the loop body
          : mapStmt(s, f));
        if ((s.kind === "let" || s.kind === "let-bind" || s.kind === "ghostLet") && s.name === from) shadowed = true;
      }
      return { ...x, body };
    }
    return null;
  };
  return mapExpr(e, f);
}



/** Map over all sub-expressions in a TExpr (typed IR). */
function mapTExpr(e: TExpr, f: (e: TExpr) => TExpr | null): TExpr {
  const hit = f(e);
  if (hit) return hit;
  const r = (x: TExpr) => mapTExpr(x, f);
  switch (e.kind) {
    case "var": case "num": case "bigint": case "str": case "bool": case "havoc": return e;
    case "binop": return { ...e, left: r(e.left), right: r(e.right) };
    case "unop": return { ...e, expr: r(e.expr) };
    case "call": return { ...e, fn: r(e.fn), args: e.args.map(r) };
    case "index": return { ...e, obj: r(e.obj), idx: r(e.idx) };
    case "field": return { ...e, obj: r(e.obj) };
    case "record": return { ...e, spread: e.spread ? r(e.spread) : null, fields: e.fields.map(fi => ({ ...fi, value: r(fi.value) })) };
    case "arrayLiteral": return { ...e, elems: e.elems.map(r) };
    case "conditional": return { ...e, cond: r(e.cond), then: r(e.then), else: r(e.else) };
    case "optChain": return { ...e, obj: r(e.obj),
      chain: e.chain.map(s => s.kind === "call" ? { ...s, args: s.args.map(r) }
        : s.kind === "index" ? { ...s, idx: r(s.idx) }
        : s) };
    case "nullish": return { ...e, left: r(e.left), right: r(e.right) };
    case "someMatch": return { ...e, scrutinee: r(e.scrutinee), someBody: r(e.someBody), noneBody: r(e.noneBody) };
    case "tagMatch": return { ...e, scrutinee: r(e.scrutinee),
      cases: e.cases.map(c => ({ ...c, body: r(c.body) })),
      fallthrough: e.fallthrough ? r(e.fallthrough) : null };
    case "forall": return { ...e, body: r(e.body) };
    case "exists": return { ...e, body: r(e.body) };
    case "lambda": return e;
  }
}

/** Map over all expressions in a TStmt tree (typed IR). */
function mapTStmt(s: TStmt, f: (e: TExpr) => TExpr | null): TStmt {
  const r = (e: TExpr) => mapTExpr(e, f);
  switch (s.kind) {
    case "let": return { ...s, init: r(s.init) };
    case "assign": return { ...s, value: r(s.value) };
    case "return": return { ...s, value: r(s.value) };
    case "break": case "continue": case "throw": return s;
    case "expr": return { ...s, expr: r(s.expr) };
    case "if": return { ...s, cond: r(s.cond), then: s.then.map(t => mapTStmt(t, f)), else: s.else.map(t => mapTStmt(t, f)) };
    case "while": return { ...s, cond: r(s.cond), invariants: s.invariants.map(r), body: s.body.map(t => mapTStmt(t, f)) };
    case "switch": return { ...s, expr: r(s.expr), cases: s.cases.map(c => ({ ...c, body: c.body.map(t => mapTStmt(t, f)) })), defaultBody: s.defaultBody.map(t => mapTStmt(t, f)) };
    case "forof": return { ...s, iterable: r(s.iterable), invariants: s.invariants.map(r), body: s.body.map(t => mapTStmt(t, f)) };
    case "ghostLet": return { ...s, init: r(s.init) };
    case "ghostAssign": return { ...s, value: r(s.value) };
    case "assert": return { ...s, expr: r(s.expr) };
    case "someMatch": return { ...s, scrutinee: r(s.scrutinee), someBody: s.someBody.map(t => mapTStmt(t, f)), noneBody: s.noneBody.map(t => mapTStmt(t, f)) };
    case "tagMatch": return { ...s, scrutinee: r(s.scrutinee),
      cases: s.cases.map(c => ({ ...c, body: c.body.map(t => mapTStmt(t, f)) })),
      fallthrough: s.fallthrough.map(t => mapTStmt(t, f)) };
  }
}

// ── Backend configuration ───────────────────────────────────

export type Backend = "lean" | "dafny";

export interface TransformOptions {
  backend: Backend;
  monadic: boolean;
}

export const LEAN_OPTIONS: TransformOptions = {
  backend: "lean",
  monadic: true,
};

export const DAFNY_OPTIONS: TransformOptions = {
  backend: "dafny",
  monadic: false,
};

/** Active options — set before each transform call. */
let _opts: TransformOptions = DAFNY_OPTIONS;

/** Type declarations — set once per module transform for discriminated union handling. */
let _typeDecls: TypeDeclInfo[] = [];

/** Names of functions that get a `Pure.` mirror (Lean). A bare reference to one
 *  in a higher-order position resolves to the monadic method, so it must be
 *  redirected to the pure mirror. Set once per module transform. */
let _pureDefNames: Set<string> = new Set();

/** Discriminated unions whose tag is read as a *value* (`x.kind` compared
 *  to another union's tag, passed as an argument, …). Each gets a generated
 *  `<Union>_<disc>` discriminator function beside its datatype, returning
 *  the source tag strings. Narrowing consumes discriminant *checks*, so this
 *  fires only for surviving reads. Populated during body transforms; drained
 *  into the types file. */
let _neededKindHelpers = new Map<string, TypeDeclInfo>();

function kindHelperName(decl: TypeDeclInfo): string {
  return freshName(`${decl.name}_${decl.discriminant}`);
}

function kindHelperDecl(decl: TypeDeclInfo): Decl {
  return {
    kind: "def",
    name: kindHelperName(decl),
    typeParams: [],
    params: [{ name: "t", type: { kind: "user", name: decl.name } }],
    returnType: { kind: "string" },
    requires: [], ensures: [], decreases: null,
    body: {
      kind: "match", scrutinee: varE("t"),
      arms: decl.variants!.map(v => ({
        pattern: { kind: "ctor" as const, ctor: v.name, binders: v.fields.map((_, i) => `_${i}`) },
        body: { kind: "str" as const, value: v.name },
      })),
    },
  };
}

/** Prefix match-bound field names to avoid capturing user variables.
 *  When prefix is given (the scrutinee name), include it to avoid
 *  collisions in nested matches on different variables. `freshName` closes
 *  the residual gap: a user variable literally named `_value`/`_x_field` in an
 *  arm body would still be captured, so prime on any module-wide collision.
 *  Deterministic, so the pattern binder and its body substitutions agree. */
function matchBinder(fieldName: string, prefix?: string): string {
  const safePrefix = prefix === "\\result"
    ? "result"
    : prefix?.replace(/[^A-Za-z0-9_]/g, "_");
  return freshName(safePrefix ? `_${safePrefix}_${fieldName}` : `_${fieldName}`);
}

/** Build a match arm pattern like `.VariantName _v_field1 _v_field2` from variant info. */
function buildMatchPattern(variantName: string, fields: { name: string }[], scopePrefix?: string): MatchPattern {
  return pCtor(variantName, ...fields.map(f => matchBinder(f.name, scopePrefix)));
}

const _forofCounters = new Map<string, number>();
function isNat(ty: Ty): boolean { return ty.kind === "nat"; }
function isIntegral(ty: Ty): boolean { return ty.kind === "int" || ty.kind === "nat"; }
function isArray(ty: Ty): boolean { return ty.kind === "array"; }
function isUser(ty: Ty): boolean { return ty.kind === "user"; }
function isRecordType(ty: Ty): boolean {
  return declOfTy(_typeDecls, ty)?.kind === "record";
}

/** Truthiness test for a *lowered* value of source type `ty`, used by `||`
 *  falsiness lowering. Which types need one is `isFalsyCapableTy` (shared with
 *  condition-facts' falsy gate); this adds the per-type test. Returns null for
 *  the always-truthy types so callers can unwrap directly instead of emitting
 *  a redundant guard. */
function valueTruthyCond(value: Expr, ty: Ty): Expr | null {
  if (!isFalsyCapableTy(ty)) return null;
  switch (ty.kind) {
    case "int": case "nat":
      return { kind: "binop", op: "≠", left: value, right: { kind: "num", value: 0 } };
    case "string":
      return { kind: "binop", op: ">", left: { kind: "field", obj: value, field: "length" }, right: { kind: "num", value: 0 } };
    case "bool":
      return value;
    default:
      return null;
  }
}

/** Check if transformed lambda body contains monadic binds. */
function isMonadicBody(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === "let-bind" || s.kind === "bind") return true;
    if (s.kind === "if" && (isMonadicBody(s.then) || isMonadicBody(s.else))) return true;
    if (s.kind === "while" && isMonadicBody(s.body)) return true;
    if (s.kind === "forin" && isMonadicBody(s.body)) return true;
    if (s.kind === "match") {
      for (const arm of s.arms) if (isMonadicBody(arm.body)) return true;
    }
  }
  return false;
}


// ── Transform expressions ────────────────────────────────────

/** Prop-valued operators (for specs/invariants). */
const OP_MAP: Record<string, string> = {
  "===": "=", "!==": "≠", ">=": "≥", "<=": "≤", ">": ">", "<": "<",
  "&&": "∧", "||": "∨", "+": "+", "-": "-", "*": "*", "/": "/", "%": "%",
  "==": "=", "!=": "≠", "<==>": "↔",
};

/** Relational operators with their operands swapped (`a < b` ≡ `b > a`). */
const MIRROR_OP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** Bool-valued operators (for code-level conditions needing Decidable). */
const BOOL_OP_MAP: Record<string, string> = {
  ...OP_MAP, "===": "==", "!==": "!=",
};

/** Arithmetic + comparison ops eligible for int→real operand coercion. */
const NUMERIC_OPS = new Set(["+", "-", "*", "/", "===", "!==", ">=", "<=", ">", "<"]);

function transformExpr(e: TExpr): Expr { return lowerExpr(e, null); }

/** Reduce an if/let/return-shaped statement body to a single expression, for
 *  expression-only lambda bodies. Returns null for shapes that can't be a pure
 *  expression (loops, assignments, bare side effects), so callers leave the
 *  body as statements. A `return` is terminal — statements after it are
 *  unreachable and dropped.
 *    [return e]                          → e
 *    [let x = e, …rest]                  → Expr.let(x, e, flatten(rest))
 *    [if (c) thenStmts elseStmts, …rest] → Expr.if(c, …) where each branch
 *        absorbs `rest` if it doesn't already terminate with a return. */
function flattenLambdaBody(stmts: Stmt[]): Expr | null {
  if (stmts.length === 0) return null;
  const first = stmts[0]!;
  const rest = stmts.slice(1);
  if (first.kind === "return") return first.value;
  if (first.kind === "let" && !first.mutable) {
    const body = flattenLambdaBody(rest);
    return body === null ? null : { kind: "let", name: first.name, value: first.value, body };
  }
  if (first.kind === "if") {
    const thenTerminates = flattenLambdaBody(first.then);
    if (thenTerminates !== null) {
      // then-branch yields a value (ends in return) → `rest` is the else path.
      const elseExpr = flattenLambdaBody(first.else.length > 0 ? [...first.else, ...rest] : rest);
      return elseExpr === null ? null : { kind: "if", cond: first.cond, then: thenTerminates, else: elseExpr };
    }
    // then-branch falls through → both branches continue into `rest`.
    const thenExpr = flattenLambdaBody([...first.then, ...rest]);
    const elseExpr = flattenLambdaBody(first.else.length > 0 ? [...first.else, ...rest] : rest);
    return thenExpr === null || elseExpr === null ? null : { kind: "if", cond: first.cond, then: thenExpr, else: elseExpr };
  }
  // A `switch` lowered to a match-statement: reduce each arm's body to an
  // expression (an arm that doesn't return falls through into `rest`), giving a
  // match-expression — same reduction the `if` case does, one level wider.
  if (first.kind === "match") {
    const arms: MatchArm[] = [];
    for (const arm of first.arms) {
      const armExpr = flattenLambdaBody([...arm.body, ...rest]);
      if (armExpr === null) return null;
      arms.push({ pattern: arm.pattern, body: armExpr });
    }
    return { kind: "match", scrutinee: first.scrutinee, arms };
  }
  return null;
}

/**
 * Lower a typed expression to Backend IR.
 *
 * When `binds` is non-null, embedded method calls are extracted into
 * `let ← ` binds (monadic lifting / selective ANF).  Lifting propagates
 * through binop, unop, and call arguments — the expression kinds where
 * a method call can appear inline in TS.  It does NOT propagate into
 * field, index, record, forall, or exists sub-expressions.
 */

/** JS truthiness coercion for `if`/`while`/`?:` conditions.
 *  Dafny requires bool; coerce number→`!== 0`, string→non-empty, array→`true`
 *  (every array, even `[]`, is truthy in JS).
 *
 *  Rewrites the typed tree, before lowering, and distributes over `&&`/`||`:
 *  each operand of a logical connective is itself in condition position, and the
 *  operands need not share a type — `i >= 0 && carry`, with `carry` an int, is a
 *  bool conjoined with a number. A conjunction takes its type from its right
 *  operand (resolve), so coercing the whole expression by its type would emit
 *  `((i >= 0) && carry) != 0`, which is not well-typed.
 *
 *  Optional conds never arrive here — narrow.ts rewrites them to someMatch. */
function asCondition(e: TExpr): TExpr {
  const bool: Ty = { kind: "bool" };
  if (e.ty.kind === "bool") return e;
  if (e.kind === "binop" && (e.op === "&&" || e.op === "||"))
    return { ...e, left: asCondition(e.left), right: asCondition(e.right), ty: bool };
  if (e.ty.kind === "int" || e.ty.kind === "nat")
    return { kind: "binop", op: "!==", left: e, right: { kind: "num", value: 0, ty: e.ty }, ty: bool };
  if (e.ty.kind === "string")
    return { kind: "binop", op: ">",
      left: { kind: "field", obj: e, field: "length", ty: { kind: "nat" } },
      right: { kind: "num", value: 0, ty: { kind: "nat" } }, ty: bool };
  // Arrays, objects, maps, sets, tuples are always truthy in JS (even `[]`/`{}`).
  if (["array", "user", "map", "set", "tuple"].includes(e.ty.kind))
    return { kind: "bool", value: true, ty: bool };
  return e;
}

/** Wrap an expression in Some/None for optional-typed conditionals.
 *  If the raw TExpr is `undefined`, emit `.none`; otherwise wrap in `Some`. */
function wrapOptionalBranch(expr: Expr, raw: TExpr): Expr {
  // Set type: "Option" so Lean emits `Option.some`/`Option.none` (qualified).
  // The dotted form `.some`/`.none` would be ambiguous in expression positions
  // like the scrutinee of an outer match. Dafny treats `Option.Some` and bare
  // `Some` equivalently — the qualification is harmless there.
  if (raw.kind === "var" && raw.name === "undefined") return { kind: "constructor", name: "none", type: "Option", args: [] };
  if (raw.ty.kind === "optional") return expr;  // already Option<T>, don't double-wrap
  return { kind: "constructor", name: "some", type: "Option", args: [expr] };
}

/** Lean needs `let mut` for any local that is later reassigned. A const local
 *  whose collection field is mutated (`b.items.push(v)` → `b := b.(items := …)`)
 *  becomes an assign in the lowered body, so scan for assign targets and flip
 *  matching lets to mutable. Harmless on Dafny (method locals are `var`); and an
 *  assigned let already forces a method, so purity is unaffected. */
function promoteAssignedLets(stmts: Stmt[]): Stmt[] {
  const assigned = new Set<string>();
  const collect = (ss: Stmt[]) => {
    for (const s of ss) {
      if (s.kind === "assign") assigned.add(s.target);
      else if (s.kind === "if") { collect(s.then); collect(s.else); }
      else if (s.kind === "while" || s.kind === "forin") collect(s.body);
      else if (s.kind === "match") s.arms.forEach(a => collect(a.body));
    }
  };
  collect(stmts);
  if (assigned.size === 0) return stmts;
  const fix = (ss: Stmt[]): Stmt[] => ss.map(s => {
    const s2: Stmt = s.kind === "let" && !s.mutable && assigned.has(s.name) ? { ...s, mutable: true } : s;
    if (s2.kind === "if") return { ...s2, then: fix(s2.then), else: fix(s2.else) };
    if (s2.kind === "while" || s2.kind === "forin") return { ...s2, body: fix(s2.body) };
    if (s2.kind === "match") return { ...s2, arms: s2.arms.map(a => ({ ...a, body: fix(a.body) })) };
    return s2;
  });
  return fix(stmts);
}

/** Build a nested record-update assigning `newVal` to a field-path receiver
 *  rooted at a var: `b.a.items` → `b := b.(a := b.a.(items := newVal))`.
 *  Returns null if the path isn't a chain of field accesses ending at a var. */
function buildNestedFieldUpdate(recv: TExpr, newVal: Expr): { root: string; value: Expr } | null {
  if (recv.kind !== "field") return null;
  const upd: Expr = { kind: "record", spread: lowerExpr(recv.obj, null), fields: [{ name: recv.field, value: newVal }] };
  if (recv.obj.kind === "var") return { root: recv.obj.name, value: upd };
  if (recv.obj.kind === "field") return buildNestedFieldUpdate(recv.obj, upd);
  return null;
}

function lowerExpr(e: TExpr, binds: Stmt[] | null): Expr {
  // Monadic lifting: extract embedded method calls to let-binds.
  // `callKind: "method"` means a global var-fn call (classifyCall returns
  // "method" only for `fn.kind === "var"`). Receiver method calls have
  // callKind "unknown" and fall through to the regular case below where
  // they become `methodCall`.
  if (binds && e.kind === "call" && e.callKind === "method" && e.fn.kind === "var") {
    const name = freshName(`_t${_liftCounter++}`);
    const args = e.args.map(a => lowerExpr(a, binds));
    binds.push({ kind: "let-bind", name, value: { kind: "app", fn: e.fn.name, args } });
    return { kind: "var", name };
  }

  switch (e.kind) {
    case "var": return { kind: "var", name: e.name };
    case "num": return { kind: "num", value: e.value };
    case "bigint": return { kind: "bigint", value: e.value };
    case "bool": return { kind: "bool", value: e.value };

    case "str":
      if (e.ty.kind === "user") return { kind: "constructor", name: e.value, type: e.ty.name, args: [] };
      return { kind: "str", value: e.value };

    case "unop":
      // Only `num` folds. A `bigint` payload is a string, so negating it here
      // would coerce through `Number` and round: `-9007199254740993n` stays a
      // structural `unop("-", bigint(...))` and is negated by the emitter.
      if (e.op === "-" && e.expr.kind === "num")
        return { kind: "num", value: -e.expr.value };
      // String truthiness: !str → str == ""
      if (e.op === "!" && e.expr.ty.kind === "string")
        return { kind: "binop", op: "=", left: lowerExpr(e.expr, binds), right: { kind: "str", value: "" } };
      // Optional truthiness: !opt → None negates to `true`. The Some branch is
      // `!(value truthy)`: always-truthy inners (array/user) give a plain `false`,
      // while falsy-capable inners re-test the wrapped value (`!Some(0)` is `true`).
      // Mirrors the `||` falsiness rule.
      if (e.op === "!" && e.expr.ty.kind === "optional") {
        const bound = matchBinder("value");
        const truthy = valueTruthyCond({ kind: "var", name: bound }, e.expr.ty.inner);
        return {
          kind: "match", scrutinee: lowerExpr(e.expr, binds),
          arms: [
            { pattern: pCtor("some", bound), body: truthy ? { kind: "unop", op: "¬", expr: truthy } : { kind: "bool", value: false } },
            { pattern: pCtor("none"), body: { kind: "bool", value: true } },
          ],
        };
      }
      // Number truthiness: !n → n == 0
      if (e.op === "!" && (e.expr.ty.kind === "int" || e.expr.ty.kind === "nat"))
        return { kind: "binop", op: "=", left: lowerExpr(e.expr, binds), right: { kind: "num", value: 0 } };
      // Object truthiness: arrays, objects, maps, and sets are always truthy in
      // JS, so `!x` is always false.
      if (e.op === "!" && ["array", "user", "map", "set", "tuple"].includes(e.expr.ty.kind)) {
        lowerExpr(e.expr, binds);  // preserve any lifted side effects; value is the constant false
        return { kind: "bool", value: false };
      }
      return { kind: "unop", op: e.op === "!" ? "¬" : e.op, expr: lowerExpr(e.expr, binds) };

    case "binop": {
      // Implication: flatten (A && B) ==> C → implies [A, B] C
      // Spec-only — no lifting through premises/conclusion.
      if (e.op === "==>") {
        const { premises, conclusion } = flattenImpl(e);
        return { kind: "implies", premises: premises.map(transformExpr), conclusion: transformExpr(conclusion) };
      }
      // Discriminant check: x.discriminant === "foo" → x = .foo (before generic string literal comparison)
      if ((e.op === "===" || e.op === "!==") && e.left.kind === "field" && e.left.isDiscriminant && e.right.kind === "str") {
        const objTy = e.left.obj.ty.kind === "user" ? e.left.obj.ty.name : undefined;
        return {
          kind: "binop",
          op: e.op === "===" ? "=" : "≠",
          left: transformExpr(e.left.obj),
          right: { kind: "constructor", name: e.right.value, type: objTy, args: [] },
        };
      }
      // String literal comparison — constructor if user type, string literal if string.
      // Skip when the left is optional: fall through to the optional-comparison rule,
      // which unwraps and compares the inner value (`Some(v) => v == "")`.
      if ((e.op === "===" || e.op === "!==") && e.right.kind === "str" && e.left.ty.kind !== "optional") {
        const left = lowerExpr(e.left, binds);
        const leftTy = e.left.ty.kind === "user" ? e.left.ty.name : undefined;
        const right: Expr = isUser(e.left.ty)
          ? { kind: "constructor", name: e.right.value, type: leftTy, args: [] }
          : { kind: "str", value: e.right.value };
        return { kind: "binop", op: e.op === "===" ? "=" : "≠", left, right };
      }
      // Optional comparison: optExpr op val → match optExpr { Some(v) => v op val, None => false/true }
      if (["===", "!==", ">=", "<=", ">", "<"].includes(e.op) &&
          (e.left.ty.kind === "optional") !== (e.right.ty.kind === "optional")) {
        const [optSide, valSide] = e.left.ty.kind === "optional" ? [e.left, e.right] : [e.right, e.left];
        const optExpr = lowerExpr(optSide, binds);
        // x === undefined → None?, x !== undefined → Some?
        if (valSide.kind === "var" && valSide.name === "undefined") {
          const isNone = e.op === "===";
          return {
            kind: "match", scrutinee: optExpr,
            arms: [
              { pattern: pCtor("some", "_"), body: { kind: "bool", value: !isNone } },
              { pattern: pCtor("none"), body: { kind: "bool", value: isNone } },
            ],
          };
        }
        // A string literal compared against an optional user type is the variant
        // constructor (`o === "red"` → `Some(v) => v == Color.red`), mirroring the
        // non-optional string-literal rule above.
        const innerTy = optSide.ty.kind === "optional" ? optSide.ty.inner : optSide.ty;
        const valExpr: Expr = valSide.kind === "str" && innerTy.kind === "user"
          ? { kind: "constructor", name: valSide.value, type: innerTy.name, args: [] }
          : lowerExpr(valSide, binds);
        // The bound value goes on the left, so mirror the operator when the
        // optional was on the right: `x < opt` → `Some(v) => v > x`.
        const op = e.left.ty.kind === "optional" ? e.op : MIRROR_OP[e.op] ?? e.op;
        const cmpOp = BOOL_OP_MAP[op] ?? op;
        const noneVal = e.op === "!==" ? true : false;
        const bound = matchBinder("value");
        return {
          kind: "match", scrutinee: optExpr,
          arms: [
            { pattern: pCtor("some", bound), body: { kind: "binop", op: cmpOp, left: { kind: "var", name: bound }, right: valExpr } },
            { pattern: pCtor("none"), body: { kind: "bool", value: noneVal } },
          ],
        };
      }
      // || undefined on optional → identity (no-op: x || undefined = x) when the
      // inner type is always truthy. When it can be falsy, JS still drops the
      // wrapped value: `Some(0) || undefined === undefined`, so the Some arm
      // re-tests and falls back to None.
      if (e.op === "||" && e.left.ty.kind === "optional" &&
          e.right.kind === "var" && e.right.name === "undefined") {
        const optExpr = lowerExpr(e.left, binds);
        const bound = matchBinder("value");
        const truthy = valueTruthyCond({ kind: "var", name: bound }, e.left.ty.inner);
        if (!truthy) return optExpr;
        return {
          kind: "match", scrutinee: optExpr,
          arms: [
            { pattern: pCtor("some", bound), body: {
              kind: "if", cond: truthy,
              then: { kind: "app", fn: "Some", args: [{ kind: "var", name: bound }] },
              else: { kind: "var", name: "undefined" } } },
            { pattern: pCtor("none"), body: { kind: "var", name: "undefined" } },
          ],
        };
      }
      // || on optional → match Some/None with default. JS `||` tests falsiness of
      // the *unwrapped* value, so when the inner type can be falsy the Some arm must
      // re-test (`Some(0) || 1 === 1`); array/user inners are always truthy and
      // unwrap directly. Same gate as condition-facts' `canBeFalsy`.
      if (e.op === "||" && e.left.ty.kind === "optional") {
        const optExpr = lowerExpr(e.left, binds);
        const defaultExpr = lowerExpr(e.right, binds);
        const bound = matchBinder("value");
        const truthy = valueTruthyCond({ kind: "var", name: bound }, e.left.ty.inner);
        const someBody: Expr = truthy
          ? { kind: "if", cond: truthy, then: { kind: "var", name: bound }, else: defaultExpr }
          : { kind: "var", name: bound };
        return {
          kind: "match", scrutinee: optExpr,
          arms: [
            { pattern: pCtor("some", bound), body: someBody },
            { pattern: pCtor("none"), body: defaultExpr },
          ],
        };
      }
      // || on map index → if key in map then map[key] else default. The stored
      // value is still subject to JS falsiness (`counts.get(k) || 1` returns 1 when
      // the stored value is 0), so for falsy-capable value types the present branch
      // re-tests the value too. Always-truthy value types unwrap directly.
      if (e.op === "||" && e.left.kind === "index" && e.left.obj.ty.kind === "map") {
        const map = lowerExpr(e.left.obj, binds);
        const key = lowerExpr(e.left.idx, binds);
        const right = lowerExpr(e.right, binds);
        const got: Expr = { kind: "index", arr: map, idx: key };
        const truthy = valueTruthyCond(got, e.left.obj.ty.value);
        return {
          kind: "if",
          cond: { kind: "binop", op: "in", left: key, right: map },
          then: truthy ? { kind: "if", cond: truthy, then: got, else: right } : got,
          else: right,
        };
      }
      // || on non-optional array → `xs` itself: every array (even `[]`) is truthy
      // in JS, so `xs || ys` short-circuits to `xs` and `ys` is never evaluated.
      // resolve types the whole `||` as the array, so any optional context (e.g.
      // `xs || undefined`) gets its single Some-wrap from the standard coercion at
      // the use site — this rule must not add one. Mirrors the `!array` rule above.
      if (e.op === "||" && e.left.ty.kind === "array") {
        return lowerExpr(e.left, binds);
      }
      // || on non-optional string/user → if non-empty then x else default
      if (e.op === "||" && (e.left.ty.kind === "string" ||
          (e.left.ty.kind === "user" && e.right.ty.kind === "string"))) {
        const left = lowerExpr(e.left, binds);
        const right = lowerExpr(e.right, binds);
        // `s || undefined` produces `Option<string>` — wrap the truthy branch in Some.
        const rightIsUndef = e.right.kind === "var" && e.right.name === "undefined";
        return {
          kind: "if",
          // strings carry the `length` marker — it renders to `|x|` in Dafny and
          // `.length` in Lean (whose String has no `.size` field).
          cond: { kind: "binop", op: ">", left: { kind: "field", obj: left, field: e.left.ty.kind === "string" ? "length" : "size" }, right: { kind: "num", value: 0 } },
          then: rightIsUndef ? { kind: "app", fn: "Some", args: [left] } : left,
          else: right,
        };
      }
      // `bool || undefined` → `if bool then Some(bool) else None`. Used in
      // optional-field initialization where the source assigns a truthy/false
      // bool to a `T?` field. Without this, emit produces `bool || None`,
      // which Dafny rejects (bool || Option<?> is ill-typed).
      if (e.op === "||" && e.left.ty.kind === "bool" &&
          e.right.kind === "var" && e.right.name === "undefined") {
        const left = lowerExpr(e.left, binds);
        return {
          kind: "if",
          cond: left,
          then: { kind: "app", fn: "Some", args: [left] },
          else: { kind: "var", name: "undefined" },
        };
      }
      // || on a number → `if x != 0 then x else default` (0 the only falsy int).
      if (e.op === "||" && (e.left.ty.kind === "int" || e.left.ty.kind === "nat")) {
        const left = lowerExpr(e.left, binds);
        const right = lowerExpr(e.right, binds);
        const truthy = valueTruthyCond(left, e.left.ty)!;
        return { kind: "if", cond: truthy, then: left, else: right };
      }
      // String concatenation: `+` with a string operand. Stringify int/nat
      // operands (Dafny NatToString, Lean toString) and join with arrayConcat
      // (rendered `+` in Dafny, `++` in Lean).
      if (e.op === "+" && (e.left.ty.kind === "string" || e.right.ty.kind === "string")) {
        const strify = (o: TExpr): Expr => {
          if (o.ty.kind !== "int" && o.ty.kind !== "nat") return lowerExpr(o, binds);
          // Lean `toString` handles any Int; Dafny needs IntToString for signed
          // ints (NatToString is nat-only).
          const fn = _opts.backend !== "dafny" ? "ToString" : o.ty.kind === "nat" ? "NatToString" : "IntToString";
          return { kind: "app", fn, args: [lowerExpr(o, binds)] };
        };
        return { kind: "binop", op: "arrayConcat", left: strify(e.left), right: strify(e.right) };
      }
      // JS `%` is truncated (sign of the dividend); a signed `int` differs from the
      // Euclidean `%` of Dafny/Lean, so route it through JSRem (Lean: `Int.tmod`).
      if (e.op === "%" && e.left.ty.kind === "int") {
        return { kind: "app", fn: "JSRem", args: [lowerExpr(e.left, binds), lowerExpr(e.right, binds)] };
      }
      // JS bigint `/` truncates toward zero (`-3n / 2n === -1n`); it differs from the
      // floored `/` of Dafny/Lean, so route it through JSTruncDiv (Lean: `Int.tdiv`).
      if (e.op === "/" && e.ty.kind === "int") {
        return { kind: "app", fn: "JSTruncDiv", args: [lowerExpr(e.left, binds), lowerExpr(e.right, binds)] };
      }
      // JS string ordering is lexicographic vs Dafny's seq prefix order, so route
      // through JSStringLt. Dafny-only: Lean's native `<` is already lexicographic.
      if (_opts.backend === "dafny" && ["<", "<=", ">", ">="].includes(e.op) && e.left.ty.kind === "string") {
        const l = lowerExpr(e.left, binds), r = lowerExpr(e.right, binds);
        const lt = (x: Expr, y: Expr): Expr => ({ kind: "app", fn: "JSStringLt", args: [x, y] });
        const not = (x: Expr): Expr => ({ kind: "unop", op: "¬", expr: x });
        if (e.op === "<") return lt(l, r);
        if (e.op === ">") return lt(r, l);
        if (e.op === "<=") return not(lt(r, l));
        return not(lt(l, r));  // >=
      }
      // Numeric int→real coercion. After resolve, `/` is always real, and any
      // arithmetic/comparison mixing real and integral operands is real-valued.
      // Lift each integral operand to `real` so the backend sees homogeneous
      // real operations (Dafny `as real`, Lean Int→Float).
      if (NUMERIC_OPS.has(e.op)) {
        const realCtx = e.ty.kind === "real" || e.left.ty.kind === "real" || e.right.ty.kind === "real";
        if (realCtx) {
          const lift = (operand: TExpr): Expr => {
            const lowered = lowerExpr(operand, binds);
            return isIntegral(operand.ty) ? { kind: "toReal", expr: lowered } : lowered;
          };
          return { kind: "binop", op: OP_MAP[e.op] ?? e.op, left: lift(e.left), right: lift(e.right) };
        }
      }
      return {
        kind: "binop",
        op: OP_MAP[e.op] ?? e.op,
        left: lowerExpr(e.left, binds),
        right: lowerExpr(e.right, binds),
      };
    }

    case "field":
      if (e.field === "length" && isArray(e.obj.ty))
        return { kind: "field", obj: transformExpr(e.obj), field: "size" };
      if (e.field === "length" && e.obj.ty.kind === "string")
        return { kind: "field", obj: transformExpr(e.obj), field: "length" };
      if (e.field === "size" && (e.obj.ty.kind === "map" || e.obj.ty.kind === "set"))
        return { kind: "field", obj: transformExpr(e.obj), field: "collectionSize" };
      // Boolean discriminant bare access: `result.ok` where Result has variants
      // {ok: true, ...} | {ok: false, ...}. String discriminants are always used via
      // comparison (x.kind === 'Foo' → x.Foo?), but boolean discriminants are used
      // as bare truthiness checks. Emit as the Dafny discriminator predicate for the
      // 'true' variant: result.ok → result.true_?
      if (e.isDiscriminant && e.obj.ty.kind === "user") {
        const decl = unionDeclOfTy(_typeDecls, e.obj.ty);
        if (decl?.variants?.some(v => v.name === "true")) {
          return { kind: "field", obj: transformExpr(e.obj), field: "true_?" };
        }
        // Surviving string-discriminant read (`x.kind` used as a value —
        // compared against another union's tag, passed as an argument, …):
        // lower to the generated per-union discriminator function, which
        // returns the source tag strings. Narrowing consumes discriminant
        // *checks*; this catches reads that survive as values.
        if (decl?.variants && decl.discriminant && decl.discriminant !== "__isArray__") {
          _neededKindHelpers.set(decl.name, decl);
          return { kind: "app", fn: kindHelperName(decl), args: [lowerExpr(e.obj, binds)] };
        }
      }
      // Union destructor: `x.field` where x is a discriminated union and `field`
      // is a data field of one of its variants. Dafny reads the destructor
      // directly; Lean has no field projection on a multi-ctor inductive, so tag
      // the node with the union's base name and let the Lean emitter `match`.
      if (e.obj.ty.kind === "user") {
        const baseName = tyBaseName(e.obj.ty.name);
        const decl = declOfKind(_typeDecls, baseName, "discriminated-union");
        const owners = decl?.variants?.filter(v => v.fields.some(f => f.name === e.field)) ?? [];
        if (owners.length > 0) {
          // Shared field name with differing declared types: those destructors
          // are renamed per-constructor, and the read's own resolved type
          // identifies the owning variant (the types differ exactly when the
          // rename happens). Pin it so emitters use the renamed destructor.
          const ownerTy = (v: VariantInfo) => v.fields.find(f => f.name === e.field)?.type;
          const differ = owners.some(v => {
            const a = ownerTy(v), b = ownerTy(owners[0]);
            return a && b && !tyEqual(a, b);
          });
          const matching = differ ? owners.filter(v => { const t = ownerTy(v); return t && tyEqual(t, e.ty); }) : [];
          const ctor = e.ofVariant ?? (matching.length === 1 ? matching[0].name : undefined);
          return { kind: "field", obj: transformExpr(e.obj), field: e.field, fromUnion: baseName, ctor, datatypeField: true };
        }
      }
      return { kind: "field", obj: transformExpr(e.obj), field: e.field, datatypeField: isRecordType(e.obj.ty) };

    case "index": {
      const idx = transformExpr(e.idx);
      if (e.obj.ty.kind === "tuple") {
        // resolve guarantees a numeric-literal index here; project at that slot.
        return { kind: "tupleProj", obj: transformExpr(e.obj), index: (e.idx as { value: number }).value, arity: e.obj.ty.elems.length };
      }
      if (e.obj.ty.kind === "map") {
        // Mirrors the .get() → .getDirect switch at line ~453: when resolve has
        // narrowed the index type to non-optional (via `k in m` atoms in scope),
        // emit direct access; otherwise keep the Option-producing `get`.
        const method = e.ty.kind !== "optional" ? "getDirect" : "get";
        return { kind: "methodCall", obj: transformExpr(e.obj), objTy: e.obj.ty, method, args: [idx], monadic: false };
      }
      const wrappedIdx = isArray(e.obj.ty) && !isNat(e.idx.ty) ? { kind: "toNat" as const, expr: idx } : idx;
      return { kind: "index", arr: transformExpr(e.obj), idx: wrappedIdx };
    }

    case "call": {
      // Array.isArray(x) on a synth array-union (discriminant "__isArray__")
      // → constructor predicate `x.ArrayBranch?`. Used in spec ensures and
      // anywhere `Array.isArray` escapes the narrowing rule (narrow rewrites
      // top-level if-cond Array.isArray uses; this catches the rest).
      if (e.fn.kind === "field" && e.fn.obj.kind === "var" && e.fn.obj.name === "Array" &&
          e.fn.field === "isArray" && e.args.length === 1) {
        const arg = e.args[0];
        if (arg.ty.kind === "user") {
          const decl = declOfTy(_typeDecls, arg.ty);
          if (decl?.kind === "discriminated-union" && decl.discriminant === "__isArray__") {
            return {
              kind: "binop", op: "=",
              left: lowerExpr(arg, binds),
              right: { kind: "constructor", name: "ArrayBranch", type: arg.ty.name, args: [] },
            };
          }
        }
      }
      // String.fromCharCode(n) → preamble function (inverse of charCodeAt,
      // which lowers to `(s[i] as int)`).
      if (e.fn.kind === "field" && e.fn.obj.kind === "var" && e.fn.obj.name === "String" &&
          e.fn.field === "fromCharCode" && e.args.length === 1) {
        return { kind: "app", fn: "StringFromCharCode", args: [lowerExpr(e.args[0], binds)] };
      }
      // Math.abs/min/max → preamble functions
      if (e.fn.kind === "field" && e.fn.obj.kind === "var" && e.fn.obj.name === "Math") {
        if (e.fn.field === "abs" && e.args.length === 1)
          return { kind: "app", fn: "MathAbs", args: [lowerExpr(e.args[0], binds)] };
        if (e.fn.field === "min" && e.args.length === 2)
          return { kind: "app", fn: "MathMin", args: e.args.map(a => lowerExpr(a, binds)) };
        if (e.fn.field === "max" && e.args.length === 2)
          return { kind: "app", fn: "MathMax", args: e.args.map(a => lowerExpr(a, binds)) };
      }
      // Math.ceil(x): CeilReal on real args, identity on int
      if (e.fn.kind === "field" && e.fn.field === "ceil" && e.fn.obj.kind === "var" && e.fn.obj.name === "Math" && e.args.length === 1) {
        const arg = e.args[0];
        if (arg.ty.kind === "real")
          return { kind: "app", fn: "CeilReal", args: [lowerExpr(arg, binds)] };
        return lowerExpr(arg, binds);
      }
      // Math.floor(x):
      //   - a / b on integral operands → integer floor division, kept in
      //     integer arithmetic (JSFloorDiv on Dafny; native Int/Nat `/` floors
      //     on Lean). Checked first: after resolve, `a / b` is typed `real`, so
      //     the real branch below would otherwise drag it into real arithmetic.
      //   - real arg → FloorReal (Dafny's .Floor)
      //   - int arg → identity
      if (e.fn.kind === "field" && e.fn.field === "floor" && e.fn.obj.kind === "var" && e.fn.obj.name === "Math" && e.args.length === 1) {
        const arg = e.args[0];
        if (arg.kind === "binop" && arg.op === "/" && isIntegral(arg.left.ty) && isIntegral(arg.right.ty)) {
          const l = lowerExpr(arg.left, binds), r = lowerExpr(arg.right, binds);
          return _opts.backend === "dafny"
            ? { kind: "app", fn: "JSFloorDiv", args: [l, r] }
            : { kind: "binop", op: "/", left: l, right: r };
        }
        if (arg.ty.kind === "real")
          return { kind: "app", fn: "FloorReal", args: [lowerExpr(arg, binds)] };
        return lowerExpr(arg, binds);
      }
      // Method call: receiver.method(args) → methodCall node
      if (e.fn.kind === "field") {
        const recv = lowerExpr(e.fn.obj, binds);
        let method = e.fn.field;
        const spec = e.builtinId !== undefined ? builtinSpec(e.builtinId) : null;
        // Lambda-taking array builtins (registry `hof`, comparator excluded —
        // mirrors the historical HOF_METHODS set).
        const isHOF = spec?.hof !== undefined && spec.hof.shape !== "comparator";
        const args = e.args.map((a, i) => {
          const lowered = lowerExpr(a, binds);
          // Lean: a pure fn passed to a HOF by name resolves to the monadic
          // method; redirect to its pure `Pure.` mirror.
          if (_opts.backend === "lean" && isHOF &&
              lowered.kind === "var" && _pureDefNames.has(lowered.name)) {
            return { kind: "var" as const, name: `Pure.${lowered.name}` };
          }
          // Array index args must be nat in Lean: `with`'s index (0), includes/indexOf `from` (1)
          // — registry `intArgPositions`.
          const isArrIdxArg = spec?.intArgPositions !== undefined && spec.intArgPositions.includes(i);
          if (isArrIdxArg && !isNat(a.ty)) return { kind: "toNat" as const, expr: lowered };
          return lowered;
        });
        // arr.concat(...args): each array arg is spread, each value arg appended.
        if (method === "concat" && e.fn.obj.ty.kind === "array") {
          let acc = recv;
          for (let k = 0; k < args.length; k++) {
            const piece: Expr = e.args[k].ty.kind === "array" ? args[k] : { kind: "arrayLiteral", elems: [args[k]] };
            acc = { kind: "binop", op: "arrayConcat", left: acc, right: piece };
          }
          return acc;
        }
        // Spec-context map get: result type is non-optional → direct access
        if (method === "get" && e.fn.obj.ty.kind === "map" && e.ty.kind !== "optional") {
          method = "getDirect";
        }
        // map.set(k, v): if v is an Optional-wrapped map get, unwrap to getDirect
        // (the desugared spread { ...m, [k]: m2[k] } becomes m.set(k, m2.get(k)),
        // but the value should be direct access, not Optional)
        if (method === "set" && e.fn.obj.ty.kind === "map" && args.length === 2) {
          const val = args[1];
          if (val.kind === "methodCall" && val.method === "get" && val.objTy.kind === "map") {
            args[1] = { ...val, method: "getDirect" };
          }
        }
        // Check if any lambda arg has monadic body
        const needsMonadic = _opts.monadic && args.some(a => a.kind === "lambda" && isMonadicBody(a.body));
        const result: Expr = { kind: "methodCall", obj: recv, objTy: e.fn.obj.ty, method, args, monadic: needsMonadic };
        // Monadic HOF call is itself monadic — lift via binds like a method call
        if (_opts.monadic && needsMonadic && binds) {
          const name = freshName(`_t${_liftCounter++}`);
          binds.push({ kind: "let-bind", name, value: result });
          return { kind: "var", name };
        }
        return result;
      }
      if (e.fn.kind !== "var")
        throw new Error(`Unsupported call expression: ${e.fn.kind}`);
      const prefix = e.callKind === "spec-pure" && _opts.backend === "lean" ? "Pure." : "";
      return { kind: "app", fn: prefix + e.fn.name, args: e.args.map(a => lowerExpr(a, binds)) };
    }

    case "record": {
      // Discriminated union: { kind: 'NoOp' } → constructor NoOp
      if (e.ty.kind === "user" && !e.spread) {
        const tyName = e.ty.name;
        // Match base type name (strip generic args: "Result<Model, Err>" → "Result")
        const baseName = tyBaseName(tyName);
        const decl = declOfKind(_typeDecls, baseName, "discriminated-union", "string-union");
        if (decl && decl.discriminant) {
          const discField = e.fields.find(f => f.name === decl.discriminant);
          if (discField && (discField.value.kind === "str" || discField.value.kind === "bool")) {
            const variantName = String(discField.value.kind === "str" ? discField.value.value : discField.value.value);
            const variant = decl.variants?.find(v => v.name === variantName);
            if (variant) {
              const nonDiscFields = e.fields.filter(f => f.name !== decl.discriminant);
              // Bare-constructor shortcut only when the variant truly has no
              // fields — a variant with only optional fields still needs its
              // None-filled argument list (`int_(None)`, not `int_`).
              if (variant.fields.length === 0) {
                return { kind: "constructor", name: variantName, type: tyName, args: [] };
              }
              // Constructor with args: match variant field order. Emit a bare `app`
              // (Dafny renders `variantName(args)`, a valid unqualified constructor
              // call — unchanged output) tagged with `ctorOf` so the Lean emitter,
              // which CANNOT take a bare constructor name, qualifies it as
              // `BaseType.variantName args`. Use the BASE type name (no generic args):
              // `Result.true_` is valid in Lean; `Result<Model,Err>.true_` is not.
              const args = variant.fields.map(vf => {
                const ef = nonDiscFields.find(f => f.name === vf.name);
                return ef ? lowerExpr(ef.value, binds) : { kind: "var" as const, name: "None" };
              });
              return { kind: "app", fn: variantName, args, ctorOf: baseName };
            }
          }
        }
      }
      // For spread records, propagate declared field types and wrap optionals
      if (e.spread) {
        const spreadTy = e.spread.ty.kind === "optional" ? e.spread.ty.inner : e.spread.ty;
        const structName = spreadTy.kind === "user" ? spreadTy.name : undefined;
        const structDecl = structName ? declOfKind(_typeDecls, structName, "record") : undefined;
        // Also check discriminated-union variants for field types
        const unionDecl = structName ? declOfKind(_typeDecls, structName, "discriminated-union") : undefined;
        const loweredFields = e.fields.map(f => {
          // Propagate declared field type onto value if it has unknown type
          let fieldValue = f.value;
          const fieldDecl = structDecl?.fields?.find(sf => sf.name === f.name);
          let declaredTy: Ty | undefined;
          if (fieldDecl) {
            declaredTy = fieldDecl.type;
          } else if (unionDecl?.variants) {
            for (const v of unionDecl.variants) {
              const vf = v.fields.find(vf => vf.name === f.name);
              if (vf) { declaredTy = vf.type; break; }
            }
          }
          if (declaredTy && fieldValue.ty.kind === "unknown") {
            fieldValue = { ...fieldValue, ty: declaredTy } as TExpr;
          }
          let value = lowerExpr(fieldValue, binds);
          // Wrap non-optional values in Some for optional fields
          if (declaredTy?.kind === "optional") {
            const isUndef = f.value.kind === "var" && f.value.name === "undefined";
            if (f.value.ty.kind !== "optional" && !isUndef) {
              value = { kind: "app", fn: "Some", args: [value] };
            }
          }
          return { name: f.name, value };
        });
        return { kind: "record", spread: lowerExpr(e.spread, binds), fields: loweredFields };
      }
      // Empty record with map type → empty map
      if (e.fields.length === 0 && !e.spread && e.ty.kind === "map") {
        return { kind: "emptyMap" };
      }
      // Non-empty record literal with map type — emit as a flat Dafny map
      // literal `map[k1 := v1, k2 := v2, ...]`. (A chain of `m["k" := v]`
      // works for a handful of entries but Dafny's type resolver stack-
      // overflows on hundreds; the flat form is fine at any size.)
      if (e.fields.length > 0 && !e.spread && e.ty.kind === "map") {
        return {
          kind: "mapLiteral",
          entries: e.fields.map(f => ({
            key: { kind: "str" as const, value: f.name },
            value: lowerExpr(f.value, binds),
          })),
        };
      }
      // Carry the resolved record type so the emitter can pick the right
      // constructor when two datatypes share a field-name set (Event vs
      // SparseEvent) — structural matching alone would take the first-declared.
      const recName = e.ty.kind === "user" ? tyBaseName(e.ty.name) : undefined;
      const ctor = recName && declOfKind(_typeDecls, recName, "record") ? recName : undefined;
      return { kind: "record", spread: null, ctor, fields: e.fields.map(f => ({ name: f.name, value: lowerExpr(f.value, binds) })) };
    }

    case "arrayLiteral":
      if (e.ty.kind === "map" && e.elems.length === 0) return { kind: "emptyMap" };
      if (e.ty.kind === "set" && e.elems.length === 0) return { kind: "emptySet" };
      // Set with initial elements: new Set([a, b]) → {a, b}
      if (e.ty.kind === "set") return { kind: "app", fn: "SetLiteral", args: e.elems.map(el => lowerExpr(el, binds)) };
      if (e.ty.kind === "tuple") return { kind: "tupleLiteral", elems: e.elems.map(el => lowerExpr(el, binds)) };
      return { kind: "arrayLiteral", elems: e.elems.map(el => lowerExpr(el, binds)) };

    case "lambda": {
      // Pass the module typeDecls (not []), so type lookups inside the lambda
      // body — e.g. a `switch`'s variant fields — resolve. A bare `[]` left a
      // discriminated-union switch in a lambda with binderless patterns.
      const body = transformStmts(e.body, _typeDecls);
      // Flatten an if/let/return-shaped multi-statement body into a single
      // `return <expr>` so both backends' single-return-lambda fast path emits
      // it (Dafny lambdas are expression-only; Lean prefers the expression form
      // over a `do` block). Bodies with shapes we can't reduce (loops, bare
      // side effects) are left as-is.
      const flat = flattenLambdaBody(body);
      return {
        kind: "lambda",
        params: e.params.map(p => ({ name: p.name, type: p.ty })),
        body: flat === null ? body : [{ kind: "return", value: flat }],
      };
    }

    case "forall":
      return { kind: "forall", var: e.var, type: e.varTy, body: transformExpr(e.body) };

    case "exists":
      return { kind: "exists", var: e.var, type: e.varTy, body: transformExpr(e.body) };

    case "conditional": {
      // JS truthiness coercion (string/array/int → ... > 0).  Matches SPEC §3.1
      // negation forms (`!s` → `s == ""`).  Optional conds are already
      // rewritten to someMatch by narrow.ts.
      const cond = lowerExpr(asCondition(e.cond), binds);
      let thenExpr = lowerExpr(e.then, binds);
      let elseExpr = lowerExpr(e.else, binds);
      if (e.ty.kind === "optional") {
        thenExpr = wrapOptionalBranch(thenExpr, e.then);
        elseExpr = wrapOptionalBranch(elseExpr, e.else);
      }
      return { kind: "if", cond, then: thenExpr, else: elseExpr };
    }

    case "optChain":
      // Narrow should have rewritten optChain to someMatch.
      throw new Error(`optChain reached transform — narrow should have rewritten it: ${JSON.stringify(e).slice(0, 400)}`);

    case "nullish":
      // Narrow should have rewritten nullish to someMatch.
      throw new Error(`nullish reached transform — narrow should have rewritten it: ${JSON.stringify(e).slice(0, 300)}`);

    case "havoc":
      // Dafny's * only works in var/assign positions — lift to own declaration
      if (binds) {
        const name = freshName(`_t${_liftCounter++}`);
        binds.push({ kind: "let", name, type: e.ty, mutable: false, value: { kind: "havoc", type: e.ty } });
        return { kind: "var", name };
      }
      return { kind: "havoc", type: e.ty };

    case "someMatch": {
      let someBody: Expr;
      let scrutinee: Expr | string;
      const path = asTAccessPath(e.scrutinee);
      if (path) {
        // Pure access path (var or any depth of obj.f.g.h) — substitute the
        // path with the binder pre-lowering.
        const replaced = replacePathInTExpr(e.someBody, path, e.binder, e.binderTy);
        someBody = lowerExpr(replaced, binds);
        // Bare-var shortcut, but route \result through lowerExpr so the
        // lemma-side replaceVar pass can substitute it with the function call.
        scrutinee = path.fields.length === 0 && path.rootVar !== "\\result"
          ? varE(path.rootVar)
          : lowerExpr(e.scrutinee, binds);
      } else {
        // Complex scrutinee — narrow pre-bound the someBody to use the binder directly,
        // so no substitution needed. Used by optChain rewrites.
        someBody = lowerExpr(e.someBody, binds);
        scrutinee = lowerExpr(e.scrutinee, binds);
      }
      let noneBody = lowerExpr(e.noneBody, binds);
      if (e.ty.kind === "optional") {
        someBody = wrapOptionalBranch(someBody, e.someBody);
        noneBody = wrapOptionalBranch(noneBody, e.noneBody);
      }
      return {
        kind: "match", scrutinee,
        arms: [
          { pattern: pCtor("some", e.binder), body: someBody },
          { pattern: pCtor("none"), body: noneBody },
        ],
      };
    }

    case "tagMatch": {
      // Expression-form tagMatch — emitted by `ruleImplArrayIsArray` for spec
      // implications like `Array.isArray(x) ==> B` and by
      // `ruleConditionalArrayIsArray` for ternary narrowing. Substitutes
      // scrutinee field accesses and (for synth array-unions) scrutinee
      // path occurrences inside each arm with the variant's payload binder.
      // Path scrutinees (e.g. `m.content`) get a synthesized hint derived
      // from the last field/var name so the binder reads naturally.
      const scrutinee = lowerExpr(e.scrutinee, binds);
      const decl = declOf(_typeDecls, e.typeName);
      const isSynthArrayUnion = decl?.discriminant === "__isArray__";
      const varName = e.scrutinee.kind === "var" ? e.scrutinee.name : undefined;
      const pathHint = varName ?? scrutineeHint(e.scrutinee);
      const wrapOpt = e.ty.kind === "optional";
      const arms: MatchArm[] = e.cases.map(c => {
        const variant = decl?.variants?.find(v => v.name === c.variant);
        const fields = variant?.fields ?? [];
        let body = lowerExpr(c.body, binds);
        if (varName && fields.length > 0) {
          body = replaceFieldAccess(body, varName, fields, c.variant, tyBaseName(e.typeName));
          if (isSynthArrayUnion && fields.length === 1) {
            body = replaceVarInExpr(body, varName, matchBinder(fields[0].name, varName));
          }
        } else if (!varName && isSynthArrayUnion && fields.length === 1) {
          // Path scrutinee (e.g. `m.content`): replace structural occurrences
          // with the binder var ref.
          const binderName = matchBinder(fields[0].name, pathHint);
          body = replaceExprInExpr(body, scrutinee, { kind: "var", name: binderName });
        }
        if (wrapOpt) body = wrapOptionalBranch(body, c.body);
        return { pattern: buildMatchPattern(c.variant, fields, pathHint), body };
      });
      if (e.fallthrough) {
        let body = lowerExpr(e.fallthrough, binds);
        if (wrapOpt) body = wrapOptionalBranch(body, e.fallthrough);
        arms.push({ pattern: pWild(), body });
      }
      return { kind: "match", scrutinee: varName !== undefined ? varE(varName) : scrutinee, arms };
    }
  }
}

function flattenImpl(e: TExpr): { premises: TExpr[]; conclusion: TExpr } {
  if (e.kind === "binop" && e.op === "==>") {
    const lhs = splitConj(e.left);
    const rest = flattenImpl(e.right);
    return { premises: [...lhs, ...rest.premises], conclusion: rest.conclusion };
  }
  return { premises: [], conclusion: e };
}

function splitConj(e: TExpr): TExpr[] {
  if (e.kind === "binop" && e.op === "&&") return [...splitConj(e.left), ...splitConj(e.right)];
  return [e];
}

// ── Ensures-to-match for discriminated unions ────────────────

function ensuresToMatch(e: TExpr, typeDecls: TypeDeclInfo[]): Expr | null {
  if (e.kind !== "binop" || e.op !== "==>") return null;
  if (e.left.kind !== "binop" || e.left.op !== "===") return null;
  if (e.left.left.kind !== "field" || !e.left.left.isDiscriminant || e.left.right.kind !== "str") return null;

  const obj = e.left.left.obj;
  if (obj.kind !== "var" || obj.ty.kind !== "user") return null;
  const typeName = obj.ty.name;
  const decl = declOfKind(typeDecls, typeName, "discriminated-union");
  if (!decl) return null;

  const variantName = e.left.right.value;
  const variant = decl.variants?.find(v => v.name === variantName);
  if (!variant) return null;

  const fields = variant.fields;
  const pattern = buildMatchPattern(variantName, fields, obj.name);

  let rhs = transformExpr(e.right);
  rhs = replaceFieldAccess(rhs, obj.name, fields);

  return { kind: "match", scrutinee: varE(obj.name), arms: [{ pattern, body: rhs }, { pattern: pWild(), body: { kind: "bool", value: true } }] };
}

function replaceFieldAccess(e: Expr, varName: string, fields: { name: string; tsType: string }[], ctorName?: string, ctorOf?: string): Expr {
  return mapExpr(e, x => {
    if (x.kind === "field" && x.obj.kind === "var" && x.obj.name === varName) {
      const f = fields.find(f => f.name === x.field);
      if (f) return { kind: "var", name: matchBinder(f.name, varName) };
    }
    // Datatype update of the scrutinee (`{ ...vn, f: v }`): the arm knows the
    // variant, so stamp it — emitters need it for per-constructor destructor
    // names. Recurse manually (returning a node stops mapExpr's own descent).
    if (ctorName && x.kind === "record" && !x.ctor && x.spread &&
        x.spread.kind === "var" && x.spread.name === varName) {
      return { ...x, ctor: ctorName, ctorOf,
        fields: x.fields.map(f => ({ ...f, value: replaceFieldAccess(f.value, varName, fields, ctorName, ctorOf) })) };
    }
    // If this let shadows the matched variable, stop replacing in the body
    if (x.kind === "let" && x.name === varName) return { ...x, value: replaceFieldAccess(x.value, varName, fields, ctorName, ctorOf) };
    return null;
  });
}

/** Replace bare `var(oldName)` references → `var(newName)` in lowered IR.
 *  Used inside synth array-union match arms: the user code refers to the
 *  scrutinee by its bare name (`content`), but in the arm body that name
 *  must refer to the variant's sole payload binder (`i_content_arr`). */
function replaceVarInExpr(e: Expr, oldName: string, newName: string): Expr {
  return mapExpr(e, x => {
    if (x.kind === "var" && x.name === oldName) return { kind: "var", name: newName };
    // If a binding shadows the name, stop substituting inside its body.
    if (x.kind === "let" && x.name === oldName) return { ...x, value: replaceVarInExpr(x.value, oldName, newName) };
    return null;
  });
}

/** Structural equality on Expr access-paths (var / field chain). Enough to
 *  match the scrutinee `m.content` against later occurrences in a match arm. */
function exprPathEqual(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "var" && b.kind === "var") return a.name === b.name;
  if (a.kind === "field" && b.kind === "field") return a.field === b.field && exprPathEqual(a.obj, b.obj);
  return false;
}

/** Substitute every occurrence of `target` (an access-path Expr) with `repl`
 *  inside `e`. Mirror of `replaceVarInExpr` but keyed on a sub-path rather
 *  than a bare name — needed when the narrowing scrutinee is `m.content`
 *  (field access) rather than a bare `content` (var). */
function replaceExprInExpr(e: Expr, target: Expr, repl: Expr): Expr {
  return mapExpr(e, x => {
    if (exprPathEqual(x, target)) return repl;
    return null;
  });
}

/** Extract a short reader-friendly hint for a TExpr access-path: the last
 *  field name in a field chain, or the var name. Used to derive a stable
 *  binder prefix when the scrutinee isn't a bare var. */
function scrutineeHint(e: TExpr): string {
  if (e.kind === "var") return e.name;
  if (e.kind === "field") return e.field;
  return "x";
}

// ── Transform statements ─────────────────────────────────────

// `if (X) continue; rest` → `if (!X) { rest }` at the top of a loop body.
// Dafny's lowered while-loops have the index increment at the bottom, so a
// `continue` would skip it and loop forever; rewriting to if/else lets the
// loop fall through normally. The operand is already-lowered IR, where
// negation is spelled `¬` (lowerExpr rewrites `!`).
function negateExpr(e: Expr): Expr {
  if (e.kind === "unop" && e.op === "¬") return e.expr;
  return { kind: "unop", op: "¬", expr: e };
}

/** Build the two pieces of an `arr.pop()` lowering on a named array variable:
 *  - `optValue` is `(if |arr|>0 then Some(arr[|arr|-1]) else None)` (the popped element)
 *  - `guardedTrunc` is `(if |arr|>0 then arr[..|arr|-1] else arr)` (the array minus its last element)
 *  Callers wrap these in let/assign statements appropriate to their context. */
function buildPopLowering(arrName: string, arrTy: Ty): { optValue: Expr; guardedTrunc: Expr } {
  const arrVar: Expr = { kind: "var", name: arrName };
  const arrLen: Expr = { kind: "field", obj: arrVar, field: "size" };
  const lastIdx: Expr = { kind: "binop", op: "-", left: arrLen, right: { kind: "num", value: 1 } };
  const lastElem: Expr = { kind: "index", arr: arrVar, idx: lastIdx };
  const isNonEmpty: Expr = { kind: "binop", op: ">", left: arrLen, right: { kind: "num", value: 0 } };
  const optValue: Expr = { kind: "if", cond: isNonEmpty,
    then: { kind: "app", fn: "Some", args: [lastElem] },
    else: { kind: "var", name: "undefined" } };
  const truncated: Expr = { kind: "methodCall", obj: arrVar, objTy: arrTy, method: "slice",
    args: [{ kind: "num", value: 0 }, lastIdx], monadic: false };
  const guardedTrunc: Expr = { kind: "if", cond: isNonEmpty, then: truncated, else: arrVar };
  return { optValue, guardedTrunc };
}
/**
 * Velvet (Lean backend) rejects `return` inside a loop. For a function shaped as
 * `…; while (…) { … early returns … }; return fallthrough`, hoist a mutable
 * result variable: each in-loop `return e` becomes `_loopRet := e; break`, then
 * `return _loopRet` after the loop. The trailing fallthrough return seeds
 * `_loopRet`, so a normal loop exit returns it unchanged. Dafny is untouched —
 * it keeps the native early returns.
 */
function stmtsContainReturn(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === "return") return true;
    if (s.kind === "if" && (stmtsContainReturn(s.then) || stmtsContainReturn(s.else))) return true;
    if (s.kind === "match" && s.arms.some(a => stmtsContainReturn(a.body))) return true;
    // Don't descend into a nested while — its returns would target that loop.
  }
  return false;
}

function replaceReturnsWithBreak(stmts: Stmt[], retVar: string): Stmt[] {
  return stmts.flatMap((s): Stmt[] => {
    if (s.kind === "return") return [{ kind: "assign", target: retVar, value: s.value }, { kind: "break" }];
    if (s.kind === "if") return [{ ...s, then: replaceReturnsWithBreak(s.then, retVar), else: replaceReturnsWithBreak(s.else, retVar) }];
    if (s.kind === "match") return [{ ...s, arms: s.arms.map(a => ({ ...a, body: replaceReturnsWithBreak(a.body, retVar) })) }];
    return [s];
  });
}

// Seed value for `_loopRet` when a return-in-loop function has no trailing
// fallthrough return. Readable literals for the primitives; everything else
// (user types, arrays, maps, optionals) gets a typed `default : T` rather than a
// type-incorrect `0` — these types derive `Inhabited`, so the default exists.
function defaultExprForTy(ty: Ty): Expr {
  switch (ty.kind) {
    case "bool": return { kind: "bool", value: false };
    case "string": return { kind: "str", value: "" };
    case "nat": case "int": case "real": return { kind: "num", value: 0 };
    default: return { kind: "default", type: ty };
  }
}

function eliminateReturnInLoops(stmts: Stmt[], retTy: Ty, resultInvariants: Expr[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.kind === "while" && stmtsContainReturn(s.body)) {
      const retVar = "_loopRet";
      const next = stmts[i + 1];
      const init: Expr = next && next.kind === "return" ? next.value : defaultExprForTy(retTy);
      out.push({ kind: "let", name: retVar, type: retTy, mutable: true, value: init });
      // The result variable carries the postcondition (the function's `ensures`
      // with `\result` → `_loopRet`) as a loop invariant: it holds initially (the
      // fallthrough seed) and after each `_loopRet := e; break`, so the
      // postcondition is re-established from the invariant when the loop exits.
      // Where Dafny discharged the postcondition at each `return` site, the
      // break-rewrite discharges it once, after the loop.
      out.push({ ...s, invariants: [...s.invariants, ...resultInvariants], body: replaceReturnsWithBreak(s.body, retVar) });
      out.push({ kind: "return", value: { kind: "var", name: retVar } });
      if (next && next.kind === "return") i++; // consume the seeded fallthrough return
    } else {
      out.push(s);
    }
  }
  return out;
}

/** True if `name` is referenced as a variable anywhere in `stmts`. Conservative:
 *  counts every occurrence and ignores shadowing — a spurious hit only costs an
 *  unused `let`, whereas a miss would leave a binder unbound. */
function stmtsUseVar(stmts: Stmt[], name: string): boolean {
  return anyExprInStmts(stmts, e => e.kind === "var" && e.name === name);
}

/**
 * Velvet (Lean backend) cannot synthesize a `WPGen` for a monadic statement
 * `match` on a user inductive in a method body (loom's matcher-WPGen drops a
 * `sorry`). loom *can* handle method-body `if`s (cf. examples/arrayEquals), so
 * lower such matches to discriminator `if`-chains: `match x with | .C f.. => B`
 * becomes `if x.C? then (let f := x.f-destructor; B) else …`. Constructor field
 * binders become `let`s bound to the (already-supported) union destructor. Option
 * matches and other non-user matches are left alone (loom handles those). Dafny
 * is untouched — it keeps the native match.
 */
function matchToIfChains(stmts: Stmt[]): Stmt[] {
  return stmts.flatMap((s): Stmt[] => {
    if (s.kind === "if") return [{ ...s, then: matchToIfChains(s.then), else: matchToIfChains(s.else) }];
    if (s.kind === "while") return [{ ...s, body: matchToIfChains(s.body) }];
    if (s.kind === "forin") return [{ ...s, body: matchToIfChains(s.body) }];
    if (s.kind !== "match") return [s];

    const arms = s.arms.map(a => ({ ...a, body: matchToIfChains(a.body) }));
    // Literal-value matches are not user-inductive matches and need no
    // discriminator rewrite. In particular, don't let a later ctor arm make us
    // accidentally drop an earlier literal arm from a malformed mixed match.
    if (arms.some(a => a.pattern.kind === "literal")) return [{ ...s, arms }];
    const ctorArms = arms.filter(a => a.pattern.kind === "ctor");
    const firstCtor = ctorArms[0] ? patternCtor(ctorArms[0].pattern) : undefined;
    const decl = firstCtor ? declWithVariant(_typeDecls, firstCtor) : undefined;
    if (!decl) return [{ ...s, arms }]; // not a user union (e.g. Option) — leave as match

    const scrutExpr: Expr = s.scrutinee;
    const defaultArm = arms.find(a => a.pattern.kind === "wild");
    const declaredCtors = decl.kind === "discriminated-union"
      ? decl.variants?.map(v => v.name)
      : decl.kind === "string-union" ? decl.values : undefined;
    const coveredCtors = new Set(ctorArms.map(a => patternCtor(a.pattern)).filter((c): c is string => !!c));
    const exhaustiveWithoutDefault = !defaultArm && !!declaredCtors && declaredCtors.every(c => coveredCtors.has(c));
    let elseBranch: Stmt[] = defaultArm ? defaultArm.body : [];
    for (let k = ctorArms.length - 1; k >= 0; k--) {
      const armBody = ctorArms[k].body;
      if (armBody.length === 0) continue; // empty arm (no-op) — let it fall through to `else`
      const ctor = patternCtor(ctorArms[k].pattern) ?? "";
      const binders = patternBinders(ctorArms[k].pattern);
      const variant = decl.variants?.find(v => v.name === ctor);
      // Discriminator condition. A nullary discriminated-union constructor would
      // need `DecidableEq` for `x = .Ctor` (which such unions don't derive), so
      // use a match-bool instead. Multi-field ctors already lower to a match-bool;
      // string-unions derive DecidableEq, so `=` is fine there.
      const cond: Expr = decl.kind === "discriminated-union" && binders.length === 0
        ? { kind: "match", scrutinee: scrutExpr, arms: [
            { pattern: pCtor(ctor), body: { kind: "bool", value: true } },
            { pattern: pWild(), body: { kind: "bool", value: false } }] }
        : { kind: "binop", op: "=", left: scrutExpr, right: { kind: "constructor", name: ctor, type: decl.name, args: [] } };
      // Bind only the constructor-field binders the body actually uses, pinning the
      // owning ctor so the destructor doesn't guess (variants share field names).
      const lets: Stmt[] = [];
      binders.forEach((b, i) => {
        const f = variant?.fields[i];
        if (b !== "_" && f && stmtsUseVar(armBody, b)) lets.push({
          kind: "let", name: b, type: f.type ?? { kind: "unknown" }, mutable: false,
          value: { kind: "field", obj: scrutExpr, field: f.name, fromUnion: decl.name, ctor },
        });
      });
      // An exhaustive source match has no fallthrough. Use its final arm as
      // the unconditional else branch; emitting `else pure ()` would force a
      // Unit result even when every arm returns the method's result type.
      if (exhaustiveWithoutDefault && k === ctorArms.length - 1) {
        elseBranch = [...lets, ...armBody];
        continue;
      }
      elseBranch = [{ kind: "if", cond, then: [...lets, ...armBody], else: elseBranch }];
    }
    return elseBranch;
  });
}

/** True if `stmts` contain a `break` not nested inside another while. */
function stmtsContainBreak(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === "break") return true;
    if (s.kind === "if" && (stmtsContainBreak(s.then) || stmtsContainBreak(s.else))) return true;
    if (s.kind === "match" && s.arms.some(a => stmtsContainBreak(a.body))) return true;
  }
  return false;
}

/**
 * loom's default loop-exit fact is `¬guard`, which does not hold for a loop that
 * `break`s (a break exits with the guard still true). Such loops need an explicit
 * `//@ done_with` in the TS source (`//@ done_with true` when the loop invariant
 * alone carries the exit facts). Rather than silently supplying one, reject —
 * the exit fact is part of the spec and belongs beside the invariants.
 * Lean-only; Dafny derives loop-exit facts from the break sites themselves.
 */
function requireDoneWithForBreaks(stmts: Stmt[], fnName: string): void {
  for (const s of stmts) {
    if (s.kind === "if") { requireDoneWithForBreaks(s.then, fnName); requireDoneWithForBreaks(s.else, fnName); }
    if (s.kind === "match") for (const a of s.arms) requireDoneWithForBreaks(a.body, fnName);
    if (s.kind === "while") {
      if (!s.doneWith && stmtsContainBreak(s.body)) {
        throw new Error(
          `${fnName}: loop with break needs //@ done_with on the Lean backend ` +
          `(an early return in a loop also lowers to a break). ` +
          `Use //@ done_with true when the loop invariants carry the exit facts.`);
      }
      requireDoneWithForBreaks(s.body, fnName);
    }
  }
}

/** The forin emission places the index increment at the loop-body end, so a
 *  surviving `continue` would skip it. Insert the increment immediately
 *  before every same-scope continue (nested loops own their continues),
 *  mirroring the C-style-for desugar's discipline. */
function insertIncrementBeforeContinue(stmts: Stmt[], idxName: string): Stmt[] {
  const incr: Stmt = { kind: "assign", target: idxName,
    value: { kind: "binop", op: "+", left: { kind: "var", name: idxName }, right: { kind: "num", value: 1 } } };
  const walk = (ss: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (const s of ss) {
      if (s.kind === "continue") { out.push(incr, s); continue; }
      if (s.kind === "if") { out.push({ ...s, then: walk(s.then), else: walk(s.else) }); continue; }
      if (s.kind === "match") { out.push({ ...s, arms: s.arms.map(a => ({ ...a, body: walk(a.body) })) }); continue; }
      out.push(s);
    }
    return out;
  };
  return walk(stmts);
}

function eliminateTopLevelContinue(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    // `if (X) {...A, continue}; rest` (empty else, trailing continue in then)
    // — if A is empty, rewrite to `if (!X) { rest }`; otherwise rewrite to
    // `if (X) { ...A } else { rest }`. Either form lets the loop fall through
    // naturally past the bottom of the body.
    if (s.kind === "if" && s.else.length === 0 &&
        s.then.length >= 1 && s.then[s.then.length - 1].kind === "continue") {
      const rest = eliminateTopLevelContinue(stmts.slice(i + 1));
      const thenWithoutContinue = s.then.slice(0, -1);
      if (thenWithoutContinue.length === 0) {
        out.push({ kind: "if", cond: negateExpr(s.cond), then: rest, else: [] });
      } else {
        out.push({ kind: "if", cond: s.cond, then: thenWithoutContinue, else: rest });
      }
      return out;
    }
    // narrow.ts's ruleEarlyReturnConsume rewrites `if (!x) continue; rest`
    // (when x is Optional) to a someMatch which transform.ts then emits as a
    // `match`. A trailing `continue` inside a match arm is a no-op when the
    // match is the last statement in the loop body — drop it.
    if (s.kind === "match" && i === stmts.length - 1) {
      const arms = s.arms.map(arm => {
        const b = arm.body;
        if (b.length > 0 && b[b.length - 1].kind === "continue") {
          return { ...arm, body: b.slice(0, -1) };
        }
        return arm;
      });
      out.push({ ...s, arms });
      continue;
    }
    out.push(s);
  }
  return out;
}

function transformStmts(stmts: TStmt[], typeDecls: TypeDeclInfo[]): Stmt[] {
  const result: Stmt[] = [];
  let i = 0;
  while (i < stmts.length) {
    const s = stmts[i];
    // Transform for-of → for-in over range
    if (s.kind === "forof") {
      const headName = s.names[0];
      const headTy = s.nameTypes[0] ?? { kind: "unknown" as const };
      const iterExpr = transformExpr(s.iterable);

      // All for-of shapes lower to the same range loop `for idx in 0..seq.size`;
      // they differ only in (a) which indexable `seq` is iterated and (b) the
      // per-iteration `let`s that bind the loop names. Compute the shared loop-
      // variable naming once, then let each shape fill in `seq` + `perIter`.
      const count = _forofCounters.get(headName) ?? 0;
      _forofCounters.set(headName, count + 1);
      const suffix = count === 0 ? "" : `${count + 1}`;
      const idxName = freshName(`_${headName}_idx${suffix}`);
      const idxVar: Expr = { kind: "var", name: idxName };

      let seq: Expr;
      let perIter: Stmt[];

      if (s.iterable.ty.kind === "map") {
        // for (const k of map) / for (const [k, v] of map): materialize the keys
        // as a seq and index into it; a value name looks up via getDirect.
        const keyTy = s.nameTypes[0] ?? s.iterable.ty.key ?? { kind: "unknown" as const };
        const keysSeqName = freshName(`_${headName}_keys${suffix}`);
        result.push({ kind: "let", name: keysSeqName, type: { kind: "array", elem: keyTy }, mutable: false,
          value: { kind: "app", fn: "SetToSeq", args: [{ kind: "field", obj: iterExpr, field: "keys" }] } });
        seq = { kind: "var", name: keysSeqName };
        const letKey: Stmt = { kind: "let", name: headName, type: keyTy, mutable: false, value: { kind: "index", arr: seq, idx: idxVar } };
        if (s.names.length >= 2) {
          const valueTy = s.nameTypes[1] ?? { kind: "unknown" as const };
          const letVal: Stmt = { kind: "let", name: s.names[1], type: valueTy, mutable: false,
            value: { kind: "methodCall", obj: iterExpr, objTy: s.iterable.ty, method: "getDirect", args: [{ kind: "var", name: headName }], monadic: false } };
          perIter = [letKey, letVal];
        } else {
          perIter = [letKey];
        }
      } else if (s.names.length >= 2 && s.iterable.ty.kind === "array" && s.iterable.ty.elem.kind === "tuple") {
        // for (const [a, b] of tupleArr): bind the element once, then destructure
        // it into each name via a tuple projection.
        const tupleTy = s.iterable.ty.elem;
        seq = iterExpr;
        const elemName = freshName(`_${headName}_elem${suffix}`);
        const letElem: Stmt = { kind: "let", name: elemName, type: tupleTy, mutable: false, value: { kind: "index", arr: seq, idx: idxVar } };
        perIter = [letElem, ...s.names.map((n, k): Stmt => ({
          kind: "let", name: n, type: tupleTy.elems[k] ?? { kind: "unknown" }, mutable: false,
          value: { kind: "tupleProj", obj: { kind: "var", name: elemName }, index: k, arity: tupleTy.elems.length },
        }))];
      } else {
        // Single element by index. Sets aren't indexable, so materialize first.
        if (s.iterable.ty.kind === "set") {
          const seqName = freshName(`_${headName}_seq${suffix}`);
          const elemTy: Ty = headTy.kind !== "unknown" ? headTy : { kind: "string" };
          result.push({ kind: "let", name: seqName, type: { kind: "array", elem: elemTy }, mutable: false,
            value: { kind: "app", fn: "SetToSeq", args: [iterExpr] } });
          seq = { kind: "var", name: seqName };
        } else {
          seq = iterExpr;
        }
        perIter = [{ kind: "let", name: headName, type: headTy, mutable: false, value: { kind: "index", arr: seq, idx: idxVar } }];
      }

      const arrSize: Expr = { kind: "field", obj: seq, field: "size" };
      // Auto-add bound invariant: idx ≤ bound (always true for range loops)
      const boundInv: Expr = { kind: "binop", op: "≤", left: idxVar, right: arrSize };
      const bodyStmts = insertIncrementBeforeContinue(
        eliminateTopLevelContinue(transformStmts(s.body, typeDecls)), idxName);
      result.push({
        kind: "forin", idx: idxName, bound: arrSize,
        invariants: [boundInv, ...s.invariants.map(transformExpr)],
        body: [...perIter, ...bodyStmts],
      });
      i++;
      continue;
    }
    result.push(...transformStmt(s, typeDecls));
    i++;
  }
  return result;
}

let _liftCounter = 0;

function liftMethodCalls(e: TExpr): { binds: Stmt[]; expr: Expr } {
  const binds: Stmt[] = [];
  return { binds, expr: lowerExpr(e, binds) };
}

// ── Transform statements ─────────────────────────────────────

function transformStmt(s: TStmt, typeDecls: TypeDeclInfo[]): Stmt[] {
  switch (s.kind) {
    case "let": {
      // Whole-init havoc: emit directly, no lifting
      if (s.init.kind === "havoc") {
        return [{ kind: "let", name: s.name, type: s.ty, mutable: s.mutable, value: { kind: "havoc", type: s.init.ty } }];
      }
      // arr.shift()! → let x = arr[0]; arr = arr[1..]
      const init = s.init.kind === "call" ? s.init : undefined;
      if (init && init.fn.kind === "field" && init.fn.field === "shift" && init.fn.obj.ty.kind === "array") {
        const arrName = init.fn.obj.kind === "var" ? init.fn.obj.name : undefined;
        if (arrName) {
          const arrVar: Expr = { kind: "var", name: arrName };
          const letHead: Stmt = { kind: "let", name: s.name, type: s.ty, mutable: s.mutable,
            value: { kind: "index", arr: arrVar, idx: { kind: "num", value: 0 } } };
          const sliceTail: Stmt = { kind: "assign", target: arrName,
            value: { kind: "methodCall", obj: arrVar, objTy: init.fn.obj.ty, method: "slice", args: [{ kind: "num", value: 1 }], monadic: false } };
          return [letHead, sliceTail];
        }
      }
      // let x = arr.pop() → let x: T? = (Option-expr); arr := (truncated-or-self)
      if (init && init.fn.kind === "field" && init.fn.field === "pop" && init.fn.obj.ty.kind === "array") {
        const arrName = init.fn.obj.kind === "var" ? init.fn.obj.name : undefined;
        if (arrName) {
          const { optValue, guardedTrunc } = buildPopLowering(arrName, init.fn.obj.ty);
          return [
            { kind: "let", name: s.name, type: s.ty, mutable: s.mutable, value: optValue },
            { kind: "assign", target: arrName, value: guardedTrunc },
          ];
        }
      }
      // new Map(arr.map(n => [n.field, n])) → let m = map[]; for (n of arr) m[n.field] := n
      if (init && init.fn.kind === "var" && init.fn.name === "__mapFromArray" &&
          init.args.length === 1 && init.args[0].kind === "call" &&
          init.args[0].fn.kind === "field" && init.args[0].fn.field === "map" &&
          init.args[0].args.length === 1 && init.args[0].args[0].kind === "lambda") {
        const arrExpr = init.args[0].fn.obj;
        const lam = init.args[0].args[0];
        const param = lam.params[0]?.name ?? "_";
        const lamBody = Array.isArray(lam.body) ? lam.body : [{ kind: "return" as const, value: lam.body }];
        const retStmt = lamBody.find(b => b.kind === "return") as { kind: "return"; value: TExpr } | undefined;
        if (retStmt && retStmt.value.kind === "arrayLiteral" && retStmt.value.elems.length === 2) {
          const keyExpr = retStmt.value.elems[0];
          const valExpr = retStmt.value.elems[1];
          const arrIR = transformExpr(arrExpr);
          const arrTy = arrExpr.ty;
          const elemTy = arrTy.kind === "array" ? arrTy.elem : { kind: "unknown" as const };
          const idxName = freshName(`_${param}_idx`);
          const idx: Expr = { kind: "var", name: idxName };
          const arrSize: Expr = { kind: "field", obj: arrIR, field: "size" };
          const elemVar: Expr = { kind: "var", name: param };
          const keyIR = transformExpr(keyExpr);
          const valIR = transformExpr(valExpr);
          const mapSet: Expr = { kind: "methodCall", obj: { kind: "var", name: s.name }, objTy: s.ty, method: "set", args: [keyIR, valIR], monadic: false };
          // Auto-invariant: all processed elements' keys are in the map. The
          // quantifier wraps user expressions, so its binder must be fresh.
          const kiName = freshName("ki");
          const kVar: Expr = { kind: "var", name: kiName };
          const mapHasKey: Expr = {
            kind: "implies",
            premises: [
              { kind: "binop", op: "≥", left: kVar, right: { kind: "num", value: 0 } },
              { kind: "binop", op: "<", left: kVar, right: idx },
            ],
            conclusion: { kind: "methodCall", obj: { kind: "var", name: s.name }, objTy: s.ty, method: "has", args: [keyIR.kind === "field" ? { kind: "field", obj: { kind: "index", arr: arrIR, idx: kVar }, field: (keyIR as any).field } : keyIR], monadic: false },
          };
          const autoInv: Expr = { kind: "forall", var: kiName, type: { kind: "int" }, body: mapHasKey };
          const stmts: Stmt[] = [
            { kind: "let", name: s.name, type: s.ty, mutable: true, value: { kind: "emptyMap" } },
            { kind: "forin", idx: idxName, bound: arrSize,
              invariants: [{ kind: "binop", op: "≤", left: idx, right: arrSize }, autoInv],
              body: [
                { kind: "let", name: param, type: elemTy, mutable: false, value: { kind: "index", arr: arrIR, idx } },
                { kind: "assign", target: s.name, value: mapSet },
              ] },
          ];
          return stmts;
        }
      }
      const { binds, expr } = liftMethodCalls(s.init);
      return [...binds, { kind: "let", name: s.name, type: s.ty, mutable: s.mutable, value: expr }];
    }

    case "assign": {
      // x = arr.pop() → x := (Option-expr); arr := (truncated-or-self)
      if (s.value.kind === "call" && s.value.fn.kind === "field" &&
          s.value.fn.field === "pop" && s.value.fn.obj.ty.kind === "array" &&
          s.value.fn.obj.kind === "var") {
        const arrName = s.value.fn.obj.name;
        const { optValue, guardedTrunc } = buildPopLowering(arrName, s.value.fn.obj.ty);
        return [
          { kind: "assign", target: s.target, value: optValue },
          { kind: "assign", target: arrName, value: guardedTrunc },
        ];
      }
      // Top-level method call → direct monadic bind, no lifting needed
      if (s.value.kind === "call" && s.value.callKind === "method")
        return [{ kind: "bind", target: s.target, value: transformExpr(s.value) }];
      const { binds, expr } = liftMethodCalls(s.value);
      return [...binds, { kind: "assign", target: s.target, value: expr }];
    }

    case "return": {
      const { binds, expr } = liftMethodCalls(s.value);
      return [...binds, { kind: "return", value: expr }];
    }
    case "break": return [{ kind: "break" }];
    case "continue": return [{ kind: "continue" }];
    case "expr": {
      // Mutating collection call: m.set(k, v) → m := m.set(k, v) (same for set
      // .add/.delete and array .push). The receiver may be a bare var, or a
      // field path rooted at a var (b.items.push(v) → b := b.(items := b.items + [v])).
      if (s.expr.kind === "call" && s.expr.fn.kind === "field") {
        const recv = s.expr.fn.obj;
        const f = s.expr.fn.field;
        const isMutating =
          ((recv.ty.kind === "map" || recv.ty.kind === "set") && (f === "set" || f === "add" || f === "delete")) ||
          (recv.ty.kind === "array" && (f === "push" || f === "unshift" || f === "sort"));
        if (isMutating && recv.kind === "var") {
          const { binds, expr } = liftMethodCalls(s.expr);
          return [...binds, { kind: "assign", target: recv.name, value: expr }];
        }
        if (isMutating && recv.kind === "field") {
          const { binds, expr } = liftMethodCalls(s.expr);
          const upd = buildNestedFieldUpdate(recv, expr);
          if (upd) return [...binds, { kind: "assign", target: upd.root, value: upd.value }];
        }
      }
      // Optional chaining on map.get at statement level: m.get(k)?.push(v)
      // → if k in m { m[k] := m[k] + [v] } (actual mutation, not value-discard).
      // Narrow rewrote this to a someMatch — destructure to find the underlying
      // m.get(k) scrutinee and the .push(v) body call.
      if (s.expr.kind === "someMatch" &&
          s.expr.scrutinee.kind === "call" && s.expr.scrutinee.fn.kind === "field" &&
          s.expr.scrutinee.fn.field === "get" && s.expr.scrutinee.fn.obj.ty.kind === "map" &&
          s.expr.someBody.kind === "call" && s.expr.someBody.fn.kind === "field" &&
          s.expr.someBody.fn.field === "push") {
        const mapExpr = s.expr.scrutinee.fn.obj;
        const mapName = mapExpr.kind === "var" ? mapExpr.name : undefined;
        const keyExpr = lowerExpr(s.expr.scrutinee.args[0], null);
        const pushArg = lowerExpr(s.expr.someBody.args[0], null);
        if (mapName) {
          const mapVar: Expr = { kind: "var", name: mapName };
          const directGet: Expr = { kind: "methodCall", obj: mapVar, objTy: mapExpr.ty, method: "getDirect", args: [keyExpr], monadic: false };
          const pushed: Expr = { kind: "methodCall", obj: directGet, objTy: (mapExpr.ty as any).value, method: "push", args: [pushArg], monadic: false };
          const updated: Expr = { kind: "methodCall", obj: mapVar, objTy: mapExpr.ty, method: "set", args: [keyExpr, pushed], monadic: false };
          const hasCond: Expr = { kind: "methodCall", obj: mapVar, objTy: mapExpr.ty, method: "has", args: [keyExpr], monadic: false };
          return [{ kind: "if", cond: hasCond, then: [{ kind: "assign", target: mapName, value: updated }], else: [] }];
        }
      }
      const { binds, expr } = liftMethodCalls(s.expr);
      return [...binds, { kind: "assign", target: "_", value: expr }];
    }

    case "if": {
      // Lift from condition only (Lean rule: don't lift from branches).
      const { binds, expr: cond } = liftMethodCalls(asCondition(s.cond));
      return [...binds, { kind: "if", cond, then: transformStmts(s.then, typeDecls), else: transformStmts(s.else, typeDecls) }];
    }

    case "while":
      return [{
        kind: "while",
        cond: transformExpr(asCondition(s.cond)),
        invariants: s.invariants.map(transformExpr),
        decreasing: s.decreases ? transformExpr(s.decreases) : null,
        doneWith: s.doneWith ? transformExpr(s.doneWith) : null,
        body: eliminateTopLevelContinue(transformStmts(s.body, typeDecls)),
      }];

    case "throw":
      return [{ kind: "assert", expr: { kind: "bool", value: false } }];

    case "forof":
      throw new Error("forof should be transformed to forin (range loop) in transformStmts");

    case "switch":
      return [emitSwitchStmt(s, typeDecls)];

    case "ghostLet":
      return [{ kind: "ghostLet", name: s.name, type: s.ty, value: transformExpr(s.init) }];

    case "ghostAssign":
      return [{ kind: "ghostAssign", target: s.target, value: transformExpr(s.value) }];

    case "assert":
      return [{ kind: "assert", expr: transformExpr(s.expr), assumed: s.assumed }];

    case "someMatch": {
      const path = asTAccessPath(s.scrutinee);
      if (path) {
        const replaced = replacePathInTStmts(s.someBody, path, s.binder, s.binderTy);
        const someBody = transformStmts(replaced, typeDecls);
        const noneBody = transformStmts(s.noneBody, typeDecls);
        const scrutinee: Expr = path.fields.length === 0 ? varE(path.rootVar) : transformExpr(s.scrutinee);
        return [{
          kind: "match", scrutinee,
          arms: [
            { pattern: pCtor("some", s.binder), body: someBody },
            { pattern: pCtor("none"), body: noneBody },
          ],
        }];
      }
      throw new Error(`someMatch stmt scrutinee must be a pure access path, got ${s.scrutinee.kind}`);
    }

    case "tagMatch":
      return [emitMatchStmt(s.scrutinee, s.typeName, s.cases, s.fallthrough, typeDecls)];
  }
}

// ── Discriminant if-chain detection ──────────────────────────

interface Chain {
  varName: string;
  typeName: string;
  cases: { variant: string; body: TStmt[] }[];
  fallthrough: TStmt[];
}

/** Apply an expression transform to all expressions in a statement (convenience wrapper). */
function mapStmtExprs(s: Stmt, r: (e: Expr) => Expr): Stmt {
  return mapStmt(s, e => r(e));
}

/** Build match arms from variant cases — shared by imperative and pure paths.
 *  Looks up variant fields from typeDecls, builds patterns via buildMatchPattern,
 *  and delegates body transformation to the caller-provided function.
 *  Returns null if any body transformation returns null (pure path abort). */
function buildMatchArms<T>(
  cases: { name: string; body: TStmt[] }[],
  varName: string | undefined, typeName: string, typeDecls: TypeDeclInfo[],
  transformBody: (body: TStmt[], varName: string | undefined, fields: { name: string; tsType: string }[], ctorName?: string) => T | null
): { pattern: MatchPattern; body: T }[] | null {
  const decl = declOf(typeDecls, typeName);
  if (!decl || (decl.kind !== "string-union" && decl.kind !== "discriminated-union")) {
    throw new Error(`match type ${typeName} is not a declared union`);
  }
  const arms: { pattern: MatchPattern; body: T }[] = [];
  for (const c of cases) {
    const variant = decl?.variants?.find(v => v.name === c.name);
    const declared = decl.kind === "string-union"
      ? decl.values?.includes(c.name)
      : !!variant;
    if (!declared) throw new Error(`case ${JSON.stringify(c.name)} is not a variant of ${typeName}`);
    const fields = variant?.fields ?? [];
    const pattern = buildMatchPattern(c.name, fields, varName);
    const body = transformBody(c.body, varName, fields, c.name);
    if (body === null) return null;
    arms.push({ pattern, body });
  }
  return arms;
}

/** Build value-pattern arms for a switch on a plain string. Case labels have
 *  already been validated and decoded by extraction; unlike datatype cases,
 *  these are literal values and introduce no constructor-field binders. */
function buildLiteralMatchArms<T>(
  cases: { name: string; body: TStmt[] }[],
  transformBody: (body: TStmt[]) => T | null,
): { pattern: MatchPattern; body: T }[] | null {
  const arms: { pattern: MatchPattern; body: T }[] = [];
  for (const c of cases) {
    const body = transformBody(c.body);
    if (body === null) return null;
    arms.push({ pattern: pLiteral(c.name), body });
  }
  return arms;
}

function emitMatchStmt(
  scrutinee: TExpr,
  typeName: string,
  cases: { variant: string; body: TStmt[] }[],
  fallthrough: TStmt[],
  typeDecls: TypeDeclInfo[],
): Stmt {
  const decl = declOf(typeDecls, typeName);
  // Synth array-unions (discriminant "__isArray__") have single-field variants
  // ArrayBranch(arr) / NonArrayBranch(val). The matched arm refers to the
  // scrutinee by its bare name/path (`content`, `m.content`), not `.arr`, so
  // we substitute that whole reference with the variant's sole field binder.
  const isSynthArrayUnion = decl?.discriminant === "__isArray__";
  // The scrutinee is a bare var (`current`) or a field-access path
  // (`current.content`). `prefix` names the binder scope — the var name, or a
  // safe id derived from the path (`current.content` → `current_content`) —
  // and is used for both pattern binders and arm-body substitution so they
  // always agree. A var scrutinee has empty `fields`, so `prefix` is just its
  // name and the emitted code is unchanged from before this generalization.
  const path = asTAccessPath(scrutinee);
  const isPath = !!path && path.fields.length > 0;
  const prefix = path ? [path.rootVar, ...path.fields].join("_") : "?";
  function transformArmBody(body: TStmt[], fields: { name: string; tsType: string; type?: Ty }[]): Stmt[] {
    let stmts: TStmt[];
    if (isPath && path) {
      // Path scrutinee: the matched value is referred to by the bare path, so
      // substitute the whole path (only the synth single-field shape arises
      // here — discriminant chains require a var scrutinee).
      stmts = isSynthArrayUnion && fields.length === 1
        ? replacePathInTStmts(body, path, matchBinder(fields[0].name, prefix), fields[0].type ?? parseTsType(fields[0].tsType))
        : body;
    } else {
      stmts = replaceFieldAccessInTStmts(body, prefix, fields);
      if (isSynthArrayUnion && fields.length === 1) {
        const f = fields[0];
        stmts = replaceVarInTStmts(stmts, prefix, matchBinder(f.name, prefix), f.type ?? parseTsType(f.tsType));
      }
    }
    return transformStmts(stmts, typeDecls);
  }
  const armCases = cases.map(c => ({ name: c.variant, body: c.body }));
  const arms = buildMatchArms(armCases, prefix, typeName, typeDecls,
    (body, _vn, fields) => transformArmBody(body, fields))!;
  // Add the fallthrough arm whenever the listed cases don't cover every
  // variant — needed for exhaustiveness even when there's no `else`
  // (`fallthrough` empty), e.g. `if (Array.isArray(x)) {...}` with no else
  // becomes `match x { case ArrayBranch(..) => ... case NonArrayBranch(..) => }`.
  const allCovered = !!decl?.variants && cases.length >= decl.variants.length;
  if (!allCovered) {
    const remaining = remainingVariant(typeName, cases, typeDecls);
    if (remaining) {
      // Exactly one variant left — destructure so the fallthrough body can
      // access variant-specific fields (Lean requires this; Dafny tolerates `_`).
      const pattern = buildMatchPattern(remaining.name, remaining.fields, prefix);
      const body = transformArmBody(fallthrough, remaining.fields);
      arms.push({ pattern, body });
    } else {
      arms.push({ pattern: pWild(), body: transformStmts(fallthrough, typeDecls) });
    }
  }
  return { kind: "match", scrutinee: isPath ? transformExpr(scrutinee) : varE(prefix), arms };
}

/** Replace bare `var(oldName)` references → `var(newName)` with the given type.
 *  Used by emitMatchStmt for synth array-unions where the variant has a single
 *  payload field and the user code refers to the scrutinee by its bare name. */
function replaceVarInTStmts(stmts: TStmt[], oldName: string, newName: string, newTy: Ty): TStmt[] {
  return stmts.map(s => mapTStmt(s, e => {
    if (e.kind === "var" && e.name === oldName) {
      return { kind: "var", name: newName, ty: newTy } as TExpr;
    }
    return null;
  }));
}

/** If the chain has matched all variants but one, return that remaining variant. */
function remainingVariant(typeName: string, cases: { variant: string }[], typeDecls: TypeDeclInfo[]): { name: string; fields: { name: string; tsType: string; type?: Ty }[] } | null {
  const decl = declOf(typeDecls, typeName);
  if (!decl?.variants) return null;
  const matched = new Set(cases.map(c => c.variant));
  const remaining = decl.variants.filter(v => !matched.has(v.name));
  if (remaining.length !== 1) return null;
  return remaining[0];
}

/** `switch(obj.field)` is stripped at extraction to scrutinee `obj` + discriminant
 *  `field`, assuming `obj` is a discriminated union with `field` as its
 *  discriminant. When that's NOT so — e.g. `obj` is a plain record with an
 *  enum- or string-typed `field` — the switch is really on the field VALUE. This
 *  returns the scrutinee `obj.field` (+ its resolved type) to match directly; null
 *  for a genuine discriminant switch or `switch(localVar)`, which callers handle
 *  their usual way. Shared by emitSwitchStmt and transformPureSwitch. */
function enumFieldSwitch(s: TStmt & { kind: "switch" }, typeDecls: TypeDeclInfo[]): { scrutinee: Expr; fieldTy: Ty | undefined } | null {
  if (!s.discriminant) return null;
  const objDecl = declOfTy(typeDecls, s.expr.ty);
  if (objDecl?.kind === "discriminated-union" && objDecl.discriminant === s.discriminant) return null;
  const fieldTy = objDecl?.kind === "record" ? objDecl.fields?.find(f => f.name === s.discriminant)?.type : undefined;
  return {
    scrutinee: { kind: "field", obj: transformExpr(s.expr), field: s.discriminant },
    fieldTy,
  };
}

/** Declared datatype matched by a switch, excluding records/aliases/opaque
 *  types. A plain `string` intentionally has no declaration and uses literal
 *  patterns instead. */
function switchCtorDecl(typeDecls: TypeDeclInfo[], ty: Ty | undefined): TypeDeclInfo | undefined {
  if (!ty) return undefined;
  const decl = declOfTy(typeDecls, ty);
  return decl?.kind === "string-union" || decl?.kind === "discriminated-union" ? decl : undefined;
}

/** Stamp variant ctor info onto datatype updates of the match scrutinee in
 *  lowered arm bodies (`{ ...vn, f: v }`) — the statement-path twin of
 *  `replaceFieldAccess`'s stamping. Emitters need the pin to use
 *  per-constructor destructor names for collision-renamed fields. */
function stampScrutineeUpdates(body: Stmt[], varName: string, ctorName: string, ctorOf: string): Stmt[] {
  const stamp = (x: Expr): Expr | null => {
    if (x.kind === "record" && !x.ctor && x.spread &&
        x.spread.kind === "var" && x.spread.name === varName) {
      return { ...x, ctor: ctorName, ctorOf,
        fields: x.fields.map(f => ({ ...f, value: mapExpr(f.value, stamp) })) };
    }
    return null;
  };
  return body.map(st => mapStmt(st, stamp));
}

function emitSwitchStmt(s: TStmt & { kind: "switch" }, typeDecls: TypeDeclInfo[]): Stmt {
  const cases = s.cases.map(c => ({ name: c.label, body: c.body }));
  const ef = enumFieldSwitch(s, typeDecls);
  const matchTy = ef ? ef.fieldTy : s.expr.ty;
  const literalCases = matchTy?.kind === "string";
  const ctorDecl = switchCtorDecl(typeDecls, matchTy);
  if (!literalCases && !ctorDecl) {
    const typeName = !matchTy ? "unknown" : matchTy.kind === "user" ? matchTy.name : matchTy.kind;
    throw new Error(`switch scrutinee must be string-typed or a declared union, got ${typeName}`);
  }
  const baseName = s.expr.ty.kind === "user" ? tyBaseName(s.expr.ty.name) : undefined;
  const arms = literalCases
    ? buildLiteralMatchArms(cases, (body) => transformStmts(body, typeDecls))!
    : ef
      ? buildMatchArms(cases, undefined, ctorDecl!.name, typeDecls, (body) => transformStmts(body, typeDecls))!
      : buildMatchArms(cases, s.expr.kind === "var" ? s.expr.name : "?", ctorDecl!.name, typeDecls,
        (body, vn, fields, ctorName) => {
          let out = transformStmts(replaceFieldAccessInTStmts(body, vn!, fields), typeDecls);
          if (ctorName && vn && baseName) out = stampScrutineeUpdates(out, vn, ctorName, baseName);
          return out;
        })!;
  if (s.defaultBody.length > 0) arms.push({ pattern: pWild(), body: transformStmts(s.defaultBody, typeDecls) });
  return { kind: "match", scrutinee: ef ? ef.scrutinee : varE(s.expr.kind === "var" ? s.expr.name : "?"), arms };
}

/** Replace obj.field → replacement var in typed IR.
 *  Uses the TExpr's resolved type when available, falling back to `fallbackTy`. */
function replaceFieldsInTStmts(
  stmts: TStmt[], objName: string,
  replacements: { fieldName: string; newName: string; fallbackTy: Ty }[]
): TStmt[] {
  if (replacements.length === 0) return stmts;
  return stmts.map(s => mapTStmt(s, e => {
    if (e.kind === "field" && e.obj.kind === "var" && e.obj.name === objName) {
      const r = replacements.find(r => r.fieldName === e.field);
      if (r) {
        const ty = e.ty.kind !== "unknown" ? e.ty : r.fallbackTy;
        return { kind: "var", name: r.newName, ty } as TExpr;
      }
    }
    return null;
  }));
}

/** Replace all variant fields of obj → match binder vars in typed IR.
 *  Before replacing field reads, realize TypeScript's structural argument
 *  conversion for calls such as `helper(outcome)` inside a narrowed union arm.
 *  The source value is still the enclosing union in typed IR, while Dafny and
 *  Lean expect the helper's nominal record. Rebuild that record solely from
 *  the fields bound by this arm's match pattern. */
function replaceFieldAccessInTStmts(stmts: TStmt[], varName: string, fields: { name: string; tsType: string; type?: Ty }[]): TStmt[] {
  const projected = projectStructuralCallArgsInTStmts(stmts, varName, fields);
  return replaceFieldsInTStmts(projected, varName, fields.map(f => ({
    fieldName: f.name,
    newName: matchBinder(f.name, varName),
    fallbackTy: f.type ?? parseTsType(f.tsType),
  })));
}

/** Project a narrowed union scrutinee into a named structural record expected
 *  by a same-module/extern call. Resolution stamps named calls with paramTys;
 *  this pass fires only when every target record field has an identically typed
 *  match-bound source field. That deliberately avoids inventing a broad cast:
 *  it is the nominal-backend witness for the structural call TS already accepts. */
function projectStructuralCallArgsInTStmts(
  stmts: TStmt[], varName: string,
  fields: { name: string; tsType: string; type?: Ty }[],
): TStmt[] {
  const sourceFields = fields.map(f => ({
    ...f,
    resolvedTy: f.type ?? parseTsType(f.tsType),
  }));

  return stmts.map(s => mapTStmt(s, e => {
    if (e.kind !== "call" || !e.paramTys) return null;
    const paramTys = e.paramTys;
    let changed = false;
    const args = e.args.map((arg, i) => {
      if (arg.kind !== "var" || arg.name !== varName || i >= paramTys.length) return arg;
      const targetTy = paramTys[i];
      const targetDecl = declOfTy(_typeDecls, targetTy);
      if (targetTy.kind !== "user" || targetDecl?.kind !== "record" || !targetDecl.fields) return arg;

      const matched: { targetField: typeof targetDecl.fields[number]; sourceField: typeof sourceFields[number] }[] = [];
      for (const targetField of targetDecl.fields) {
        const sourceField = sourceFields.find(f => f.name === targetField.name);
        const targetFieldTy = targetField.type ?? parseTsType(targetField.tsType);
        if (!sourceField || !tyEqual(sourceField.resolvedTy, targetFieldTy)) return arg;
        matched.push({ targetField, sourceField });
      }

      changed = true;
      return {
        kind: "record" as const,
        spread: null,
        fields: matched.map(m => ({
          name: m.targetField.name,
          value: {
            kind: "var" as const,
            name: matchBinder(m.sourceField.name, varName),
            ty: m.sourceField.resolvedTy,
          },
        })),
        ty: targetTy,
      };
    });
    return changed ? { ...e, args } : null;
  }));
}

/** Replace obj.field → replacement var in typed IR expressions (before lowering).
 *  Mirrors replaceFieldsInTStmts but operates on a single TExpr tree. */
function replaceFieldInTExpr(
  expr: TExpr, objName: string,
  replacements: { fieldName: string; newName: string; fallbackTy: Ty }[]
): TExpr {
  if (replacements.length === 0) return expr;
  return mapTExpr(expr, e => {
    if (e.kind === "field" && e.obj.kind === "var" && e.obj.name === objName) {
      const r = replacements.find(r => r.fieldName === e.field);
      if (r) {
        const ty = e.ty.kind !== "unknown" ? e.ty : r.fallbackTy;
        return { kind: "var", name: r.newName, ty } as TExpr;
      }
    }
    return null;
  });
}

/** A pure access path — chain of field accesses rooted at a var. */
interface AccessPath { rootVar: string; fields: string[] }

function asTAccessPath(e: TExpr): AccessPath | null {
  if (e.kind === "var") return { rootVar: e.name, fields: [] };
  if (e.kind === "field") {
    const inner = asTAccessPath(e.obj);
    if (!inner) return null;
    return { rootVar: inner.rootVar, fields: [...inner.fields, e.field] };
  }
  return null;
}

/** Does TExpr `e` match the given access path exactly? */
function matchesAccessPath(e: TExpr, path: AccessPath): boolean {
  const collected: string[] = [];
  let cur = e;
  while (cur.kind === "field") { collected.unshift(cur.field); cur = cur.obj; }
  if (cur.kind !== "var" || cur.name !== path.rootVar) return false;
  if (collected.length !== path.fields.length) return false;
  return collected.every((f, i) => f === path.fields[i]);
}

/** Replace every TExpr matching `path` with `var(binder, binderTy)`. */
function replacePathInTExpr(expr: TExpr, path: AccessPath, binder: string, binderTy: Ty): TExpr {
  return mapTExpr(expr, e =>
    matchesAccessPath(e, path)
      ? { kind: "var", name: binder, ty: binderTy } as TExpr : null
  );
}

function replacePathInTStmts(stmts: TStmt[], path: AccessPath, binder: string, binderTy: Ty): TStmt[] {
  return stmts.map(s => mapTStmt(s, e =>
    matchesAccessPath(e, path)
      ? { kind: "var", name: binder, ty: binderTy } as TExpr : null
  ));
}

/** Unwrap optional type on match-bound variables in TExpr.
 *  After replaceFieldInTExpr, the replaced variable carries the original optional
 *  type from the field declaration. The match binding unwraps it to the inner type. */
function fixBoundType(expr: TExpr, boundName: string): TExpr {
  return mapTExpr(expr, e =>
    e.kind === "var" && e.name === boundName && e.ty.kind === "optional"
      ? { ...e, ty: e.ty.inner } as TExpr : null
  );
}


// ── Pure function generation ─────────────────────────────────

function transformPureBody(stmts: TStmt[], typeDecls: TypeDeclInfo[]): Expr | null {
  // tagMatch (from narrow's discriminant detection) is the leading stmt and consumes the rest.
  if (stmts.length > 0 && stmts[0].kind === "tagMatch") {
    const t = stmts[0];
    const varName = t.scrutinee.kind === "var" ? t.scrutinee.name : "?";
    const chain: Chain = { varName, typeName: t.typeName, cases: t.cases, fallthrough: t.fallthrough };
    return transformPureMatch(chain, typeDecls);
  }

  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const rest = stmts.slice(i + 1);
    switch (s.kind) {
      case "return": return transformExpr(s.value);
      case "let": {
        const restExpr = transformPureBody(rest, typeDecls);
        if (!restExpr) return null;
        return { kind: "let", name: s.name, value: transformExpr(s.init), body: restExpr };
      }
      case "if": {
        // Append rest to both branches so nested ifs that fall through
        // can reach the continuation (e.g. early return inside then-branch).
        const thenExpr = transformPureBody([...s.then, ...rest], typeDecls);
        if (!thenExpr) return null;
        const elseStmts = s.else.length > 0 ? [...s.else, ...rest] : rest;
        const elseExpr = transformPureBody(elseStmts, typeDecls);
        if (!elseExpr) return null;
        return { kind: "if", cond: transformExpr(asCondition(s.cond)), then: thenExpr, else: elseExpr };
      }
      case "switch": return transformPureSwitch(s, typeDecls);
      case "someMatch": {
        const path = asTAccessPath(s.scrutinee);
        if (path) {
          const replaced = replacePathInTStmts(s.someBody, path, s.binder, s.binderTy);
          const someExpr = transformPureBody([...replaced, ...rest], typeDecls);
          if (!someExpr) return null;
          const noneExpr = transformPureBody([...s.noneBody, ...rest], typeDecls);
          if (!noneExpr) return null;
          const scrutinee: Expr = path.fields.length === 0 ? varE(path.rootVar) : transformExpr(s.scrutinee);
          return {
            kind: "match", scrutinee,
            arms: [
              { pattern: pCtor("some", s.binder), body: someExpr },
              { pattern: pCtor("none"), body: noneExpr },
            ],
          };
        }
        throw new Error(`someMatch pure-body scrutinee must be a pure access path, got ${s.scrutinee.kind}`);
      }
      default: return null;
    }
  }
  return null;
}

function transformPureSwitch(s: TStmt & { kind: "switch" }, typeDecls: TypeDeclInfo[]): Expr | null {
  const ef = enumFieldSwitch(s, typeDecls);
  if (ef) {
    const cases = s.cases.map(c => ({ name: c.label, body: c.body }));
    const literalCases = ef.fieldTy?.kind === "string";
    const ctorDecl = switchCtorDecl(typeDecls, ef.fieldTy);
    if (!literalCases && !ctorDecl) return null;
    const arms = literalCases
      ? buildLiteralMatchArms(cases, (body) => transformPureBody(body, typeDecls))
      : buildMatchArms(cases, undefined, ctorDecl!.name, typeDecls, (body) => transformPureBody(body, typeDecls));
    if (!arms) return null;
    if (s.defaultBody.length > 0) {
      const body = transformPureBody(s.defaultBody, typeDecls);
      if (!body) return null;
      arms.push({ pattern: pWild(), body });
    }
    return { kind: "match", scrutinee: ef.scrutinee, arms };
  }
  const ctorDecl = switchCtorDecl(typeDecls, s.expr.ty);
  if (!ctorDecl) return null;
  const typeName = ctorDecl.name;
  const varName = s.expr.kind === "var" ? s.expr.name : undefined;
  const cases = s.cases.map(c => ({ name: c.label, body: c.body }));
  const arms = buildMatchArms(cases, varName, typeName, typeDecls,
    (body, vn, fields, ctorName) => {
      const projected = vn ? projectStructuralCallArgsInTStmts(body, vn, fields) : body;
      let result = transformPureBody(projected, typeDecls);
      if (!result) return null;
      if (fields.length > 0 && vn) result = replaceFieldAccess(result, vn, fields, ctorName, tyBaseName(typeName));
      return result;
    });
  if (!arms) return null;
  if (s.defaultBody.length > 0) {
    const body = transformPureBody(s.defaultBody, typeDecls);
    if (!body) return null;
    arms.push({ pattern: pWild(), body });
  }
  if (s.expr.kind !== "var") return null;
  return { kind: "match", scrutinee: varE(s.expr.name), arms };
}

function transformPureMatch(chain: Chain, typeDecls: TypeDeclInfo[]): Expr | null {
  const cases = chain.cases.map(c => ({ name: c.variant, body: c.body }));
  const decl = declOf(typeDecls, chain.typeName);
  // Synth array-unions have single-field variants and user code refers to the
  // scrutinee by its bare name, not field-accessed. See emitMatchStmt for
  // the statement-level counterpart of this substitution.
  const isSynthArrayUnion = decl?.discriminant === "__isArray__";
  const arms = buildMatchArms(cases, chain.varName, chain.typeName, typeDecls,
    (body, vn, fields, ctorName) => {
      const projected = vn ? projectStructuralCallArgsInTStmts(body, vn, fields) : body;
      let result = transformPureBody(projected, typeDecls);
      if (!result) return null;
      if (fields.length > 0 && vn) result = replaceFieldAccess(result, vn, fields, ctorName, tyBaseName(chain.typeName));
      if (isSynthArrayUnion && fields.length === 1 && vn) {
        result = replaceVarInExpr(result, vn, matchBinder(fields[0].name, vn));
      }
      return result;
    });
  if (!arms) return null;
  // Idiomatic TS often has an unreachable fallthrough after exhaustive if-chains on
  // discriminated unions. Skip the catch-all arm when all variants are matched,
  // since Lean errors on redundant match arms.
  const allCovered = decl?.variants && chain.cases.length >= decl.variants.length;
  if (chain.fallthrough.length > 0 && !allCovered) {
    const remaining = remainingVariant(chain.typeName, chain.cases, typeDecls);
    if (remaining) {
      // Exactly one variant left — destructure for variant-specific field access.
      const projected = projectStructuralCallArgsInTStmts(chain.fallthrough, chain.varName, remaining.fields);
      let body = transformPureBody(projected, typeDecls);
      if (!body) return null;
      if (remaining.fields.length > 0) body = replaceFieldAccess(body, chain.varName, remaining.fields, remaining.name, tyBaseName(chain.typeName));
      if (isSynthArrayUnion && remaining.fields.length === 1) {
        body = replaceVarInExpr(body, chain.varName, matchBinder(remaining.fields[0].name, chain.varName));
      }
      arms.push({ pattern: buildMatchPattern(remaining.name, remaining.fields, chain.varName), body });
    } else {
      const body = transformPureBody(chain.fallthrough, typeDecls);
      if (!body) return null;
      arms.push({ pattern: pWild(), body });
    }
  }
  return { kind: "match", scrutinee: varE(chain.varName), arms };
}

// ── Generate type declarations ───────────────────────────────

function transformTypeDecl(d: TypeDeclInfo): Decl {
  if (d.kind === "string-union") {
    return {
      kind: "inductive", name: d.name,
      constructors: d.values!.map(v => ({ name: v, fields: [] })),
      deriving: ["Repr", "Inhabited", "DecidableEq"],
    };
  } else if (d.kind === "discriminated-union") {
    return {
      kind: "inductive", name: d.name,
      typeParams: d.typeParams,
      constructors: d.variants!.map(v => ({
        name: v.name,
        fields: v.fields.map(f => ({ name: f.name, type: f.type! })),
      })),
      deriving: ["Repr", "Inhabited"],
    };
  } else if (d.kind === "alias") {
    return {
      kind: "type-alias", name: d.name,
      target: d.aliasOfTy!,
    };
  } else if (d.kind === "opaque") {
    return { kind: "opaque-type", name: d.name };
  } else {
    return {
      kind: "structure", name: d.name,
      typeParams: d.typeParams,
      fields: d.fields!.map(f => ({ name: f.name, type: f.type! })),
      deriving: ["Repr", "Inhabited", "DecidableEq"],
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Find parameter names that are reassigned anywhere in the body. */
function findReassignedNames(stmts: TStmt[], names: Set<string>): Set<string> {
  const found = new Set<string>();
  function scan(stmts: TStmt[]) {
    for (const s of stmts) {
      if (s.kind === "assign" && names.has(s.target)) found.add(s.target);
      if (s.kind === "ghostAssign" && names.has(s.target)) found.add(s.target);
      // Mutating collection calls: s.add(x), m.set(k,v), s.delete(x), arr.push(x)
      if (s.kind === "expr" && s.expr.kind === "call" && s.expr.fn.kind === "field" &&
          s.expr.fn.obj.kind === "var" && names.has(s.expr.fn.obj.name) &&
          ["add", "set", "delete", "push", "unshift"].includes(s.expr.fn.field)) {
        found.add(s.expr.fn.obj.name);
      }
      if (s.kind === "if") { scan(s.then); scan(s.else); }
      if (s.kind === "while") scan(s.body);
      if (s.kind === "forof") scan(s.body);
      if (s.kind === "switch") { for (const c of s.cases) scan(c.body); scan(s.defaultBody); }
    }
  }
  scan(stmts);
  return found;
}

/** Replace all occurrences of a variable name with a new expression. */
/**
 * Replace all occurrences of variable `name` with `replacement`.
 * If `narrowing` is true, the replacement is an unwrapped Optional value
 * (e.g., replacing `x: Option<T>` with `x_val: T`). In that case, when the
 * variable appears directly as a record spread field value, it's wrapped in
 * Some() to preserve the field's Optional type.
 */
function replaceVar(e: Expr, name: string, replacement: Expr, narrowing?: boolean): Expr {
  const rec = (expr: Expr) => replaceVar(expr, name, replacement, narrowing);
  return mapExpr(e, x => {
    if (x.kind === "var" && x.name === name) return replacement;
    // Record spread: wrap direct variable uses in field values with Some when narrowing
    if (narrowing && x.kind === "record" && x.spread) {
      return {
        ...x,
        spread: rec(x.spread),
        fields: x.fields.map(f => {
          if (f.value.kind === "var" && f.value.name === name) {
            return { ...f, value: { kind: "app" as const, fn: "Some", args: [replacement] } };
          }
          return { ...f, value: rec(f.value) };
        }),
      };
    }
    // Don't descend past bindings that shadow the name
    if (x.kind === "forall" && x.var === name) return x;
    if (x.kind === "exists" && x.var === name) return x;
    if (x.kind === "let" && x.name === name) return { ...x, value: replaceVar(x.value, name, replacement, narrowing) };
    return null;
  });
}

// ── Top-level transform ──────────────────────────────────────

/** Transform for Lean backend — same logic, Lean options. */
export function transformModuleLean(mod: TModule, specImport?: string, moduleBase?: string): { typesFile: Module | null; defFile: Module } {
  const prev = _opts;
  _opts = LEAN_OPTIONS;
  try {
    return transformModule(mod, specImport, moduleBase);
  } finally {
    _opts = prev;
  }
}

/** Transform for Dafny backend — same logic, Dafny options. */
export function transformModuleDafny(mod: TModule): { typesFile: Module | null; defFile: Module } {
  const prev = _opts;
  _opts = DAFNY_OPTIONS;
  try {
    return transformModule(mod);
  } finally {
    _opts = prev;
  }
}

export function transformModule(mod: TModule, specImport?: string, moduleBaseOverride?: string): { typesFile: Module | null; defFile: Module } {
  _forofCounters.clear();
  _liftCounter = 0;
  _typeDecls = mod.typeDecls;
  _neededKindHelpers = new Map();
  _pureDefNames = new Set(mod.functions.filter(f => f.isPure).map(f => f.name));
  const typeDecls = mod.typeDecls.map(transformTypeDecl);

  // Module-level constants
  const constDecls: ConstDecl[] = (mod.constants ?? []).map(c => ({
    kind: "const" as const,
    name: c.name,
    type: c.ty,
    value: transformExpr(c.value),
  }));

  // Pure function mirrors
  const pureDefs: FnDef[] = [];
  const defByMethods: FnDefByMethod[] = [];
  for (const fn of mod.functions) {
    if (!fn.isPure) continue;
    const body = transformPureBody(fn.body, mod.typeDecls);
    if (body) {
      // For pure-function lemmas, replace \result with the function call.
      const fnCall: Expr = { kind: "app", fn: fn.name, args: fn.params.map(p => ({ kind: "var" as const, name: p.name })) };
      const ensures = fn.ensures.map(e => replaceVar(transformExpr(e), "\\result", fnCall));
      pureDefs.push({
        kind: "def",
        name: fn.name,
        typeParams: fn.typeParams,
        params: fn.params.map(p => ({ name: p.name, type: p.ty })),
        returnType: fn.returnTy,
        requires: fn.requires.map(transformExpr),
        ensures,
        decreases: fn.decreases ? transformExpr(fn.decreases) : null,
        body,
      });
    } else if (fn.forcePure) {
      // //@ pure but body can't be auto-converted — emit function by method
      _forofCounters.clear();
      const methodBody = promoteAssignedLets(transformStmts(fn.body, mod.typeDecls));
      defByMethods.push({
        kind: "def-by-method",
        name: fn.name,
        typeParams: fn.typeParams,
        params: fn.params.map(p => ({ name: p.name, type: p.ty })),
        returnType: fn.returnTy,
        requires: fn.requires.map(transformExpr),
        ensures: fn.ensures.map(transformExpr),
        decreases: fn.decreases ? transformExpr(fn.decreases) : null,
        methodBody,
      });
    }
  }

  const base = mod.file.split("/").pop()?.replace(/\.ts$/, "") ?? "module";
  // Lean module base — overridable via `//@ lean-module` (see lsc.ts). Only the
  // def→types import below reads it; Dafny never passes an override.
  const moduleBase = moduleBaseOverride ?? base;

  // Externs: effectively pure declarations become uninterpreted functions;
  // impure declarations become body-less methods with independent results.
  // Contracts come along in either case. A pure extern's `\result` denotes its
  // application; an impure extern keeps `\result` for the method out-parameter.
  const externDecls: Decl[] = (mod.externs ?? []).map(ext => {
    const fnCall: Expr = { kind: "app", fn: ext.flat, args: ext.params.map(p => ({ kind: "var" as const, name: p.name })) };
    return {
      kind: "extern" as const,
      name: ext.flat,
      typeParams: ext.typeParams,
      params: ext.params.map(p => ({ name: p.name, type: p.ty })),
      returnType: ext.returnTy,
      requires: ext.requires.map(transformExpr),
      ensures: ext.ensures.map(e => ext.impure
        ? transformExpr(e)
        : replaceVar(transformExpr(e), "\\result", fnCall)),
      impure: ext.impure,
    };
  });

  // Def file: Velvet methods
  // Pure functions get a thin wrapper. Lean keeps pure definitions in the
  // `Pure` namespace; Dafny flattens that namespace, so its call is unqualified.
  // def-by-method functions also skip their method wrappers
  const pureDefNames = new Set([...pureDefs.map(d => d.name), ...defByMethods.map(d => d.name)]);
  const methods: FnMethod[] = mod.functions.map(fn => {
    const ensures: Expr[] = [];
    for (const e of fn.ensures) {
      const m = ensuresToMatch(e, mod.typeDecls);
      if (m) ensures.push(m);
      else ensures.push(transformExpr(e));
    }

    _forofCounters.clear();
    let body = pureDefNames.has(fn.name)
      ? [{ kind: "return" as const, value: { kind: "app" as const, fn: _opts.backend === "lean" ? `Pure.${fn.name}` : fn.name, args: fn.params.map(p => ({ kind: "var" as const, name: p.name })) } }]
      : promoteAssignedLets(transformStmts(fn.body, mod.typeDecls));

    // Lean-only method-body rewrites (Velvet can't WP-synthesize monadic matches
    // and forbids `return` in loops):
    //   1. monadic statement-`match` on a user union → discriminator `if`-chains
    //   2. `return` inside a loop → result var + break (postcondition as invariant)
    // Dafny keeps the native forms. Breaking loops (including those synthesized
    // by rewrite 2) must carry a `//@ done_with` in the TS source — enforced here,
    // since loom's default loop-exit fact `¬guard` does not hold across a break.
    if (_opts.backend === "lean" && !pureDefNames.has(fn.name)) {
      body = matchToIfChains(body);
      const resultInvariants = fn.ensures.map(e => replaceVar(transformExpr(e), "\\result", { kind: "var", name: "_loopRet" }));
      body = eliminateReturnInLoops(body, fn.returnTy, resultInvariants);
      requireDoneWithForBreaks(body, fn.name);
    }

    // Shadow reassigned parameters with mutable locals
    const paramNames = new Set(fn.params.map(p => p.name));
    const reassigned = findReassignedNames(fn.body, paramNames);
    if (reassigned.size > 0) {
      const shadows: Stmt[] = fn.params
        .filter(p => reassigned.has(p.name))
        .map(p => ({ kind: "let" as const, name: p.name, type: p.ty, mutable: true, value: { kind: "var" as const, name: p.name } }));
      body = [...shadows, ...body];
    }

    return {
      kind: "method" as const,
      name: fn.name,
      typeParams: fn.typeParams,
      params: fn.params.map(p => ({ name: p.name, type: p.ty })),
      returnType: fn.returnTy,
      requires: fn.requires.map(transformExpr),
      ensures,
      decreases: fn.decreases ? transformExpr(fn.decreases) : null,
      body,
    };
  });

  // Class declarations
  const classDecls: Decl[] = (mod.classes ?? []).map(cls => {
    const classMethods: FnMethod[] = cls.methods.map(fn => {
      const ensures: Expr[] = fn.ensures.map(transformExpr);
      _forofCounters.clear();
      const body = promoteAssignedLets(transformStmts(fn.body, mod.typeDecls));
      return {
        kind: "method" as const,
        name: fn.name,
        typeParams: fn.typeParams,
        params: fn.params.map(p => ({ name: p.name, type: p.ty })),
        returnType: fn.returnTy,
        requires: fn.requires.map(transformExpr),
        ensures,
        decreases: fn.decreases ? transformExpr(fn.decreases) : null,
        body,
      };
    });
    return {
      kind: "class" as const,
      name: cls.name,
      fields: cls.fields.map(f => ({ name: f.name, type: f.ty })),
      methods: classMethods,
    };
  });

  // Types file — assembled after all body transforms, so needs discovered
  // there (discriminator kind-helpers) are included.
  const kindHelpers: Decl[] = [..._neededKindHelpers.values()].map(kindHelperDecl);

  // ── Imported / undeclared user types: opaque by default ─────────────
  // A module may reference types it imports (ir.ts uses typedir's `Ty`).
  // Standalone compilation has no declaration for them; synthesize an
  // opaque type — the value passes through, uninspectable, which is the
  // only sound use of an undeclared type (same doctrine as _synthOpaque).
  // Any attempted inspection still fails loudly: an opaque type has no
  // constructors and no operations. Signature-level coverage (type-decl
  // fields, params, returns, class fields, externs, consts); a body-level
  // reference to an undeclared type still errors in the backend.
  const referenced = new Set<string>();
  const collectTy = (ty: Ty): void => {
    switch (ty.kind) {
      case "user": referenced.add(tyBaseName(ty.name)); return;
      case "array": case "set": collectTy(ty.elem); return;
      case "optional": collectTy(ty.inner); return;
      case "map": collectTy(ty.key); collectTy(ty.value); return;
      case "tuple": ty.elems.forEach(collectTy); return;
      case "fn": ty.params.forEach(collectTy); collectTy(ty.result); return;
      default: return;
    }
  };
  const knownTypeNames = new Set<string>(typeDecls.map(d => (d as { name: string }).name));
  const allTypeParams = new Set<string>();
  // Exclude type params from the *source* decls — the transformed IR drops
  // them for aliases (`type Step<S, A> = …`), and a generic alias's params
  // must not be mistaken for imported types. Params may carry a `//@ type`
  // decoration ("S(==)"); references collect as the bare name, so strip it.
  const addTp = (tp: string): void => { allTypeParams.add(tp.replace(/\(.*$/, "").trim()); };
  for (const d of mod.typeDecls) d.typeParams?.forEach(addTp);
  for (const d of typeDecls) {
    if (d.kind === "inductive") d.constructors.forEach(c => c.fields.forEach(f => collectTy(f.type)));
    else if (d.kind === "structure") d.fields.forEach(f => collectTy(f.type));
    else if (d.kind === "type-alias") collectTy(d.target);
  }
  for (const fn of mod.functions) { fn.typeParams.forEach(addTp); fn.params.forEach(p => collectTy(p.ty)); collectTy(fn.returnTy); }
  for (const cls of mod.classes ?? []) {
    cls.fields.forEach(f => collectTy(f.ty));
    for (const m of cls.methods) { m.typeParams.forEach(addTp); m.params.forEach(p => collectTy(p.ty)); collectTy(m.returnTy); }
  }
  for (const ext of mod.externs ?? []) { ext.typeParams.forEach(addTp); ext.params.forEach(p => collectTy(p.ty)); collectTy(ext.returnTy); }
  for (const c of mod.constants ?? []) collectTy(c.ty);
  const opaqueImports: Decl[] = [...referenced]
    .filter(n => !knownTypeNames.has(n) && !allTypeParams.has(n))
    .map(n => ({ kind: "opaque-type" as const, name: n }));
  const typesImports: string[] = ["LemmaScript"];
  let typesFile: Module | null = null;
  const pureNamespace: Decl[] = pureDefs.length > 0
    ? [{ kind: "namespace", name: "Pure", decls: pureDefs }]
    : [];
  if (typeDecls.length > 0 || pureDefs.length > 0 || externDecls.length > 0 || opaqueImports.length > 0) {
    // Declaration order differs by backend. Dafny allows forward references, so
    // externs go first to be in scope everywhere. Lean requires definition-before-use:
    // an extern's signature may reference a declared type (e.g. `estimateTokens(m: AgentMessage)`),
    // so types must precede externs, which in turn precede the pure mirrors that may call them.
    // Kind-helpers sit right after the datatypes they discriminate.
    const decls = _opts.backend === "lean"
      ? [...opaqueImports, ...typeDecls, ...kindHelpers, ...externDecls, ...pureNamespace]
      : [...externDecls, ...opaqueImports, ...typeDecls, ...kindHelpers, ...pureNamespace];
    typesFile = {
      comment: "  Generated by lsc — Lean types and pure function mirrors.",
      imports: typesImports,
      options: [],
      decls,
    };
  }

  const defImport = specImport ?? (typesFile ? `«${moduleBase}.types»` : null);
  const defBaseImports: string[] = defImport ? [defImport] : ["LemmaScript"];
  const defFile: Module = {
    comment: "  Generated by lsc from " + (mod.file.split("/").pop() ?? "") + "\n  Do not edit — re-run `lsc gen` to regenerate.",
    imports: defBaseImports,
    options: [
      { key: "velvet.semantics.termination", value: '"total"' },
    ],
    decls: [...constDecls, ...defByMethods, ...methods, ...classDecls],
  };

  return { typesFile, defFile };
}
