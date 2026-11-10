/**
 * Raw IR — structured AST for expressions and statements.
 *
 * Produced by the extract phase (ts-morph → RawExpr for body expressions)
 * and the specparser (annotation strings → RawExpr for spec expressions).
 *
 * Layer 1: structured (no strings for expressions)
 * Layer 2 (planned): add Ty to each node
 */

// ── Expressions ──────────────────────────────────────────────

/** Source text of a BigInt literal → the canonical decimal string stored in a
 *  `bigint` node. Shared by the body extractor and the spec parser so both
 *  sides of a function (code and `//@ ` annotations) agree exactly.
 *
 *  A BigInt literal must never pass through `Number`/`parseInt`: `9007199254740993n`
 *  and `9007199254740992n` are distinct values that collapse to the same double.
 *  Hence the string payload — it also keeps the raw IR `JSON.stringify`-able,
 *  which `lsc extract` relies on. */
export function normalizeBigIntLiteral(text: string): string {
  const withoutSuffix = text.endsWith("n") ? text.slice(0, -1) : text;
  // BigInt() understands decimal, hex, binary, and octal; numeric separators
  // are source syntax and must be stripped first.
  return BigInt(withoutSuffix.replace(/_/g, "")).toString(10);
}

/** A step in an optional chain — what to do with the binder after `?.`.
 *  field: `?.foo` or `.foo` after `?.`.
 *  call:  `?.foo()` or `.foo()` / `()` after `?.`.
 *  index: `?.[i]` or `[i]` after `?.`. */
export type RawChainStep =
  | { kind: "field"; name: string }
  | { kind: "call"; args: RawExpr[] }
  | { kind: "index"; idx: RawExpr };

export type RawExpr =
  | { kind: "var"; name: string }
  | { kind: "num"; value: number }
  | { kind: "bigint"; value: string }   // BigInt literal (123n) — canonical decimal, no `n`
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "binop"; op: string; left: RawExpr; right: RawExpr }
  | { kind: "unop"; op: string; expr: RawExpr }
  | { kind: "call"; fn: RawExpr; args: RawExpr[] }
  | { kind: "index"; obj: RawExpr; idx: RawExpr }
  | { kind: "field"; obj: RawExpr; field: string }
  | { kind: "record"; spread: RawExpr | null; fields: { name: string; value: RawExpr }[] }
  | { kind: "recordMerge"; base: RawExpr; override: RawExpr }   // { ...base, ...override } — field-wise merge; resolve expands to a record using the result type's fields
  | { kind: "arrayLiteral"; elems: RawExpr[] }
  | { kind: "lambda"; params: { name: string; tsType?: string }[]; body: RawExpr | RawStmt[]; returnTsType?: string }
  | { kind: "conditional"; cond: RawExpr; then: RawExpr; else: RawExpr }  // ternary ? :
  | { kind: "optChain"; obj: RawExpr; chain: RawChainStep[] }   // obj?.field, obj?.foo(), obj?.[i], obj?.foo.bar — single-eval
  | { kind: "nullish"; left: RawExpr; right: RawExpr }   // a ?? b — single-eval; narrow rewrites to someMatch
  | { kind: "emptyCollection"; collectionType: "Map" | "Set"; tsType: string; initElems?: RawExpr[] }  // new Map<K,V>() / new Set<T>()
  | { kind: "nonNull"; expr: RawExpr }   // expr! (non-null assertion)
  // Spec-only (from //@ annotations, produced by specparser):
  | { kind: "result" }                                    // \result
  | { kind: "forall"; var: string; varType: string; body: RawExpr }
  | { kind: "exists"; var: string; varType: string; body: RawExpr }
  // Havoc — nondeterministic value (from //@ havoc annotation):
  | { kind: "havoc"; tsType: string }

// ── Statements ───────────────────────────────────────────────

export interface RawLet {
  // tsType: explicit source annotation when present (`const x: T = ...`),
  // otherwise null — resolve infers from the initializer. Letting ts-morph's
  // inferred type string leak in here was unsafe for brownfield code where
  // the imported declaration's shape collapses to `any` (e.g. complex
  // schema-derived unions), losing the LS-visible structure.
  kind: "let";
  name: string;
  mutable: boolean;
  tsType: string | null;
  init: RawExpr;
  line: number;
}

export interface RawAssign {
  kind: "assign";
  target: string;
  value: RawExpr;
  line: number;
}

export interface RawReturn {
  kind: "return";
  value: RawExpr;
  line: number;
}

export interface RawBreak {
  kind: "break";
  line: number;
}

export interface RawContinue {
  kind: "continue";
  line: number;
}

export interface RawExprStmt {
  kind: "expr";
  expr: RawExpr;
  line: number;
}

export interface RawIf {
  kind: "if";
  cond: RawExpr;
  then: RawStmt[];
  else: RawStmt[];
  line: number;
}

export interface RawWhile {
  kind: "while";
  cond: RawExpr;
  invariants: string[];  decreases: string | null;
  doneWith: string | null;
  body: RawStmt[];
  line: number;
}

export interface RawSwitch {
  kind: "switch";
  expr: RawExpr;
  discriminant: string;     // field name if x.field, empty if just x
  // Each label is the decoded value of a source string literal.
  cases: { label: string; body: RawStmt[] }[];
  defaultBody: RawStmt[];
  line: number;
}

export interface RawForOf {
  kind: "forof";
  names: string[];        // single name or destructured: [k, v, ...]
  iterable: RawExpr;
  invariants: string[];  doneWith: string | null;
  body: RawStmt[];
  line: number;
}

export interface RawThrow {
  kind: "throw";
  line: number;
}

export interface RawGhostLet {
  kind: "ghostLet";
  name: string;
  tsType: string | null;   // explicit type annotation, or null to infer
  init: string;            // spec expression string (parsed later)
  line: number;
}

export interface RawGhostAssign {
  kind: "ghostAssign";
  target: string;
  value: string;           // spec expression string (parsed later)
  line: number;
}

export interface RawAssert {
  kind: "assert";
  expr: string;              // spec expression string (parsed later)
  line: number;
  assumed?: boolean;         // true when source was //@ assume — emitted as `assume`, not `assert`
}

export type RawStmt = RawLet | RawAssign | RawReturn | RawBreak | RawContinue | RawExprStmt | RawIf | RawWhile | RawSwitch | RawForOf | RawThrow | RawGhostLet | RawGhostAssign | RawAssert;

// ── Top-level ────────────────────────────────────────────────

export interface RawParam {
  name: string;
  tsType: string;
}

/** One original TS parameter, before `params` flattens it for the provers
 *  (destructured object → N scalars, rest → one). `params == tsParams.flatMap(p => p.binds)`. */
export interface RawTsParam {
  kind: "simple" | "object" | "rest";
  binds: string[];   // spec-param names (entries in `params`) this TS parameter contributes
  defaults?: Record<string, string>;  // bind-name → default source text (TS-only, ignored by provers), for binds that have one
}

export interface RawFunction {
  name: string;
  exported: boolean;      // part of the module's export surface (inline `export`, `export { }`, or re-export)
  typeParams: string[];   // unbounded generic type parameters (e.g. ["T"])
  params: RawParam[];
  tsParams: RawTsParam[]; // original TS signature grouping (params = flatten of this); see RawTsParam

  returnType: string;
  requires: string[];     // //@ annotation strings
  ensures: string[];
  contract: string[];     // //@ contract — natural-language description of intent (NOT a spec; provers ignore it)
  decreases: string | null;
  pure: boolean;           // //@ pure — force pure even if syntactically impure
  autohavoc: boolean;      // //@ autohavoc — abstract unmodellable exprs to havoc (file-level or per-fn)
  typeAnnotations: { name: string; type: string }[];
  body: RawStmt[];
  line: number;
}

export interface RawClass {
  name: string;
  fields: { name: string; tsType: string }[];
  methods: RawFunction[];
}

export interface RawConst {
  name: string;
  tsType: string;
  value: RawExpr;
}

/** Externally-declared function — auto-detected during call extraction when
 *  ts-morph resolves the callee to a declaration in a different `.ts` source
 *  file. Pure externs emit as Dafny `function {:axiom}` declarations; externs
 *  resolved as impure emit as body-less methods so each call may return a
 *  different value. Any `requires`/`ensures` are lifted from the source
 *  declaration so callers reason against the same per-call contract.
 *  Spec strings here are unresolved — resolve.ts parses them in the extern's
 *  own param scope. */
export interface RawExtern {
  qualified: string;       // dotted source name, e.g. "Wildcard.match"
  flat: string;            // emission name, e.g. "Wildcard_match"
  typeParams: string[];    // generic type parameters, e.g. ["S", "A"] (referenced by params/returnType)
  params: RawParam[];      // typed parameter list (names + TS type strings)
  returnType: string;      // TS type string
  requires: string[];      // copied `//@ requires` annotation strings
  ensures: string[];       // copied `//@ ensures` annotation strings
  impure: boolean;         // effective call-by-call nondeterminism (Dafny method)
}

export interface RawModule {
  file: string;
  typeDecls: import("./types.js").TypeDeclInfo[];
  externs: RawExtern[];
  constants: RawConst[];
  functions: RawFunction[];
  classes: RawClass[];
}
