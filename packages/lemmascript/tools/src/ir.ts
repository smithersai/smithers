/**
 * IR — the intermediate representation between transform and emit.
 *
 * The transform phase produces these types.
 * The emit phase pretty-prints them to backend syntax (Lean or Dafny).
 */

import type { Ty } from "./typedir.js";

// ── Expressions ──────────────────────────────────────────────

export type Expr =
  | { kind: "var"; name: string }
  | { kind: "num"; value: number }
  | { kind: "bigint"; value: string }   // exact integer literal, canonical decimal — emitted verbatim
  | { kind: "bool"; value: boolean }
  | { kind: "str"; value: string }
  | { kind: "constructor"; name: string; type?: string; args: Expr[] }   // .idle / .some x — name is lowercase; emitters capitalize per backend
  | { kind: "binop"; op: string; left: Expr; right: Expr }
  | { kind: "unop"; op: string; expr: Expr }
  | { kind: "app"; fn: string; args: Expr[]; ctorOf?: string }  // f a b; ctorOf set ⇒ fn is a datatype constructor of that (base) type. Dafny takes the bare name `fn(args)`; Lean must qualify it as `ctorOf.fn args`.
  | { kind: "field"; obj: Expr; field: string; fromUnion?: string; ctor?: string; datatypeField?: boolean }   // x.res, arr.size; fromUnion set ⇒ `field` is a destructor of that (base) discriminated-union type. Dafny reads `x.field` directly; Lean must `match` since multi-ctor inductives have no field projections. ctor pins the owning constructor when several variants share the field name. datatypeField set ⇒ `field` is a declared datatype field (proven by the transform), so the Dafny emitter projects it rather than treating `size`/`length`/`keys` as the collection intrinsic (`|obj|`, `.Keys`).
  | { kind: "toNat"; expr: Expr }                               // expr.toNat
  | { kind: "toReal"; expr: Expr }                             // int/nat → real coercion
  | { kind: "index"; arr: Expr; idx: Expr }                // arr[idx]!
  | { kind: "tupleLiteral"; elems: Expr[] }                // (a, b) — heterogeneous tuple literal
  | { kind: "tupleProj"; obj: Expr; index: number; arity: number }  // projection at a 0-based position; arity is needed only by Lean, whose right-nested Prod makes the last slot asymmetric (Dafny just uses `t.index`)
  | { kind: "record"; spread: Expr | null; fields: RecordField[]; ctor?: string; ctorOf?: string }  // ctorOf: the union whose variant `ctor` is, when a datatype update needs renamed destructors
  | { kind: "arrayLiteral"; elems: Expr[] }
  | { kind: "emptyMap" }
  | { kind: "emptySet" }
  | { kind: "mapLiteral"; entries: MapEntry[] }
  | { kind: "methodCall"; obj: Expr; objTy: Ty; method: string; args: Expr[]; monadic: boolean }
  | { kind: "lambda"; params: Param[]; body: Stmt[] }
  | { kind: "if"; cond: Expr; then: Expr; else: Expr }
  | { kind: "match"; scrutinee: Expr; arms: MatchArm[] }
  | { kind: "forall"; var: string; type: Ty; body: Expr }
  | { kind: "exists"; var: string; type: Ty; body: Expr }
  | { kind: "implies"; premises: Expr[]; conclusion: Expr }
  | { kind: "let"; name: string; value: Expr; body: Expr }
  | { kind: "havoc"; type: Ty }
  | { kind: "default"; type: Ty }                              // default value of T (Lean: `(default : T)` via Inhabited). Only produced by the return-in-loop→break rewrite, which is Lean-gated since Dafny keeps native in-loop returns; hence no Dafny producer today.

/** A match-arm pattern. Backend-neutral: `.some x`, `.syn seq`, `.none` are held
 *  structurally and rendered to each backend's constructor syntax by its emitter
 *  (`Some(x)` / `syn(seq)` in Dafny, `.some x` / `.syn seq` in Lean). String
 *  literals are stored decoded and quoted/escaped by the backend emitter. */
export type MatchPattern =
  | { kind: "wild" }                                    // "_"
  | { kind: "ctor"; ctor: string; binders: string[] }   // ".some x" ⇒ {ctor:"some", binders:["x"]}; ".none" ⇒ binders:[]
  | { kind: "literal"; value: string };                 // `"small"` ⇒ {value:"small"}

export const pWild = (): MatchPattern => ({ kind: "wild" });
export const pCtor = (c: string, ...binders: string[]): MatchPattern => ({ kind: "ctor", ctor: c, binders });
export const pLiteral = (value: string): MatchPattern => ({ kind: "literal", value });

// Named payload records for the shapes repeated across IR nodes. Purely
// structural — identical to the object-literal types they replace, so
// construction sites are unaffected.
export interface Param { name: string; type: Ty }
export interface RecordField { name: string; value: Expr }
export interface MapEntry { key: Expr; value: Expr }
export interface CtorInfo { name: string; fields: Param[] }
export interface EmitOption { key: string; value: string }

/** Binder identifiers a pattern introduces (`[]` for wildcard / nullary ctor). */
export function patternBinders(p: MatchPattern): string[] {
  return p.kind === "ctor" ? p.binders : [];
}
export function patternCtor(p: MatchPattern): string | null {
  return p.kind === "ctor" ? p.ctor : null;
}
/** Does the pattern bind `name`? */
export function patternBinds(p: MatchPattern, name: string): boolean {
  return patternBinders(p).includes(name);
}

export interface MatchArm {
  pattern: MatchPattern;
  body: Expr;
}

// ── Statements ──────────────────────────────────────────────

export type Stmt =
  | { kind: "let"; name: string; type: Ty; mutable: boolean; value: Expr }
  | { kind: "assign"; target: string; value: Expr }
  | { kind: "bind"; target: string; value: Expr }         // x ← f a b (mutation)
  | { kind: "let-bind"; name: string; value: Expr }       // let x ← f a b (new binding)
  | { kind: "return"; value: Expr }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: "match"; scrutinee: Expr; arms: StmtMatchArm[] }
  | { kind: "while"; cond: Expr; invariants: Expr[]; decreasing: Expr | null;
      doneWith: Expr | null; body: Stmt[] }
  | { kind: "forin"; idx: string; bound: Expr; invariants: Expr[]; body: Stmt[] }
  | { kind: "ghostLet"; name: string; type: Ty; value: Expr }
  | { kind: "ghostAssign"; target: string; value: Expr }
  | { kind: "assert"; expr: Expr; assumed?: boolean }

export interface StmtMatchArm {
  pattern: MatchPattern;
  body: Stmt[];
}

// ── Top-level declarations ───────────────────────────────────

export interface Inductive {
  kind: "inductive";
  name: string;
  typeParams?: string[];
  constructors: CtorInfo[];
  deriving: string[];
}

export interface Structure {
  kind: "structure";
  name: string;
  typeParams?: string[];
  fields: Param[];
  deriving: string[];
}

export interface FnDef {
  kind: "def";
  name: string;
  typeParams: string[];
  params: Param[];
  returnType: Ty;
  requires: Expr[];  // used by Dafny backend; Lean backend ignores
  ensures: Expr[];   // used by Dafny backend for companion lemma
  decreases: Expr | null;
  body: Expr;
}

export interface FnDefByMethod {
  kind: "def-by-method";
  name: string;
  typeParams: string[];
  params: Param[];
  returnType: Ty;
  requires: Expr[];
  ensures: Expr[];
  decreases: Expr | null;
  methodBody: Stmt[];
}

export interface FnMethod {
  kind: "method";
  name: string;
  typeParams: string[];
  params: Param[];
  returnType: Ty;
  requires: Expr[];
  ensures: Expr[];
  decreases: Expr | null;
  body: Stmt[];
}

export interface Namespace {
  kind: "namespace";
  name: string;
  decls: Decl[];
}

export interface ClassDecl {
  kind: "class";
  name: string;
  fields: Param[];
  methods: FnMethod[];
}

export interface ConstDecl {
  kind: "const";
  name: string;
  type: Ty;
  value: Expr;
}

export interface TypeAlias {
  kind: "type-alias";
  name: string;
  target: Ty;
}

/** Opaque abstract type: `type Name(==)` in Dafny. Synthesized for a union LS
 *  can't model as a tagged union (no runtime test maps to a tag). It has no
 *  constructor and no tag predicate, so a value of it can only be passed
 *  through — any attempt to build or type-test it fails to lower. That is the
 *  only sound use of an un-discriminable union, so the opacity is its own guard. */
export interface OpaqueType {
  kind: "opaque-type";
  name: string;
}

/** Externally-declared operation. Pure externs are uninterpreted Dafny
 *  functions; impure externs are body-less methods whose result is an
 *  independent arbitrary value at each call. Any source `requires`/`ensures`
 *  travel with the declaration. */
export interface ExternDecl {
  kind: "extern";
  name: string;                                 // flat name (dots → underscores)
  typeParams: string[];                         // generic type parameters (e.g. ["S", "A"])
  params: Param[];
  returnType: Ty;
  requires: Expr[];
  ensures: Expr[];
  impure: boolean;
}

export type Decl = Inductive | Structure | FnDef | FnDefByMethod | FnMethod | Namespace | ClassDecl | ConstDecl | TypeAlias | OpaqueType | ExternDecl;

export interface Module {
  comment: string;
  imports: string[];
  options: EmitOption[];
  decls: Decl[];
}

// ── Literal queries ──────────────────────────────────────────

/** The exact value of an integer-literal operand (possibly negated), or null
 *  when `e` isn't one. Answers in compiler-side `bigint` so a backend folding a
 *  literal into arithmetic stays exact: JS bitwise operators truncate to 32 bits
 *  and `Math.pow(2, n)` is a double, both of which lie past 2^53. A `num`
 *  outside the safe-integer range has already lost precision, so it is not a
 *  usable answer — hence null. */
export function exactIntegerLiteral(e: Expr): bigint | null {
  if (e.kind === "bigint") return BigInt(e.value);
  if (e.kind === "num") return Number.isSafeInteger(e.value) ? BigInt(e.value) : null;
  // Transform folds `-<num>` into a negative `num`, but leaves a negated
  // `bigint` structural (folding it would coerce the payload through Number).
  if (e.kind === "unop" && e.op === "-") {
    const inner = exactIntegerLiteral(e.expr);
    return inner === null ? null : -inner;
  }
  return null;
}

// ── Traversal ────────────────────────────────────────────────
//
// A single generic query visitor. `mapExpr`/`mapStmt` (in transform.ts) rewrite
// the IR; these instead *query* it. `anyExpr(e, pred)` is true iff `pred` holds
// for `e` or any sub-expression, descending through statements (lambda / if /
// match / loop bodies), short-circuiting on the first hit. Query walkers (`does X
// use var v?`, `does this body need Bool connectives?`) are one-liners on top of
// this rather than a fresh hand-rolled recursion over every node kind.

type ExprPred = (e: Expr) => boolean;

export function anyExpr(e: Expr, pred: ExprPred): boolean {
  if (pred(e)) return true;
  switch (e.kind) {
    case "var": case "num": case "bigint": case "bool": case "str":
    case "emptyMap": case "emptySet": case "havoc": case "default": return false;
    case "constructor": return e.args.some(a => anyExpr(a, pred));
    case "binop": return anyExpr(e.left, pred) || anyExpr(e.right, pred);
    case "unop": case "toNat": case "toReal": return anyExpr(e.expr, pred);
    case "app": return e.args.some(a => anyExpr(a, pred));
    case "field": return anyExpr(e.obj, pred);
    case "index": return anyExpr(e.arr, pred) || anyExpr(e.idx, pred);
    case "tupleLiteral": return e.elems.some(x => anyExpr(x, pred));
    case "tupleProj": return anyExpr(e.obj, pred);
    case "implies": return e.premises.some(p => anyExpr(p, pred)) || anyExpr(e.conclusion, pred);
    case "record": return (e.spread ? anyExpr(e.spread, pred) : false) || e.fields.some(f => anyExpr(f.value, pred));
    case "arrayLiteral": return e.elems.some(x => anyExpr(x, pred));
    case "mapLiteral": return e.entries.some(en => anyExpr(en.key, pred) || anyExpr(en.value, pred));
    case "methodCall": return anyExpr(e.obj, pred) || e.args.some(a => anyExpr(a, pred));
    case "lambda": return e.body.some(s => anyExprInStmt(s, pred));
    case "if": return anyExpr(e.cond, pred) || anyExpr(e.then, pred) || anyExpr(e.else, pred);
    case "match": return anyExpr(e.scrutinee, pred) || e.arms.some(a => anyExpr(a.body, pred));
    case "forall": case "exists": return anyExpr(e.body, pred);
    case "let": return anyExpr(e.value, pred) || anyExpr(e.body, pred);
  }
}

export function anyExprInStmt(s: Stmt, pred: ExprPred): boolean {
  switch (s.kind) {
    case "let": case "assign": case "bind": case "let-bind": case "return":
    case "ghostLet": case "ghostAssign": return anyExpr(s.value, pred);
    case "assert": return anyExpr(s.expr, pred);
    case "break": case "continue": return false;
    case "if": return anyExpr(s.cond, pred) || anyExprInStmts(s.then, pred) || anyExprInStmts(s.else, pred);
    case "match": return anyExpr(s.scrutinee, pred) || s.arms.some(a => anyExprInStmts(a.body, pred));
    case "while": return anyExpr(s.cond, pred) || s.invariants.some(i => anyExpr(i, pred))
      || (s.decreasing ? anyExpr(s.decreasing, pred) : false) || (s.doneWith ? anyExpr(s.doneWith, pred) : false)
      || anyExprInStmts(s.body, pred);
    case "forin": return anyExpr(s.bound, pred) || s.invariants.some(i => anyExpr(i, pred)) || anyExprInStmts(s.body, pred);
  }
}

export function anyExprInStmts(stmts: Stmt[], pred: ExprPred): boolean {
  return stmts.some(s => anyExprInStmt(s, pred));
}

// A name is "used" — such that a synthesized binder of the same name would
// capture or shadow it — iff it appears as a variable reference or a called
// function. These drive the *local* freshness checks for user-facing binders
// (the result out-parameter, comprehension binders): a binder is checked only
// against the expressions/scope it actually wraps, not the whole module.
const _refsName = (name: string): ExprPred =>
  (e: Expr) => (e.kind === "var" && e.name === name) ||
       (e.kind === "app" && e.fn === name) ||
       (e.kind === "constructor" && e.name === name);

export function usesName(e: Expr, name: string): boolean {
  return anyExpr(e, _refsName(name));
}

export function usesNameInStmts(stmts: Stmt[], name: string): boolean {
  return anyExprInStmts(stmts, _refsName(name));
}

/** Names a statement tree *binds, targets, or introduces* — `let`/`let-bind`/
 *  `ghostLet` names, `assign`/`bind`/`ghostAssign` targets, `for-in` indices,
 *  and `match`-arm pattern binders — recursing through nested blocks. Distinct
 *  from `usesNameInStmts` (expression references only): an unread or assign-only
 *  local still duplicate-declares against a method's out-parameter in Dafny. */
export function bindsNameInStmts(stmts: Stmt[], name: string): boolean {
  return stmts.some(s => {
    switch (s.kind) {
      case "let": case "let-bind": case "ghostLet": return s.name === name;
      case "assign": case "bind": case "ghostAssign": return s.target === name;
      case "forin": return s.idx === name || bindsNameInStmts(s.body, name);
      case "if": return bindsNameInStmts(s.then, name) || bindsNameInStmts(s.else, name);
      case "while": return bindsNameInStmts(s.body, name);
      case "match": return s.arms.some(a => patternBinds(a.pattern, name) || bindsNameInStmts(a.body, name));
      default: return false;
    }
  });
}

/** Every occurrence of `name` a method's out-parameter binder must dodge —
 *  referenced in a spec (requires/ensures) or body, *or* bound/targeted anywhere
 *  in the body (an unread local still duplicate-declares). Both emitters share it. */
export function usesNameInDecl(requires: Expr[], ensures: Expr[], body: Stmt[], name: string): boolean {
  return requires.some(e => usesName(e, name)) || ensures.some(e => usesName(e, name))
    || usesNameInStmts(body, name) || bindsNameInStmts(body, name);
}
