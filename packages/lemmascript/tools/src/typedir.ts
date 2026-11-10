/**
 * Typed IR — Raw IR annotated with resolved types and classifications.
 *
 * Produced by the resolve pass. Consumed by the transform.
 * Still TS-shaped (not Lean-shaped).
 */

// Type-only: erased at runtime, so the builtins ↔ typedir reference cycle
// never materializes.
import type { BuiltinId } from "./builtins.js";

// ── Types ────────────────────────────────────────────────────

// `big` marks an int/nat that originated from a TS `bigint` (literal `123n` or
// declared `bigint`). It rides along arithmetic so division can pick the right
// JS semantics: `number / number` is real, but `bigint / bigint` is integer.
export type Ty =
  | { kind: "bool" }
  | { kind: "nat"; big?: boolean }
  | { kind: "int"; big?: boolean }
  | { kind: "real" }
  | { kind: "string"; values?: string[] }   // values: members of an inline string-union (`"a" | "b"`), kept for record-index-by-enum
  | { kind: "void" }
  | { kind: "array"; elem: Ty }
  | { kind: "tuple"; elems: Ty[] }           // heterogeneous fixed-arity tuple (`[A, B]`); homogeneous tuples lower to `array`
  | { kind: "map"; key: Ty; value: Ty }
  | { kind: "set"; elem: Ty }
  | { kind: "optional"; inner: Ty }
  | { kind: "user"; name: string }
  | { kind: "fn"; params: Ty[]; result: Ty }
  | { kind: "unknown" }

/** True for an int/nat that came from a TS `bigint` (integer division semantics). */
export function isBigInt(ty: Ty): boolean {
  return (ty.kind === "int" || ty.kind === "nat") && !!ty.big;
}

/** Structural equality on Ty. Used to decide whether a tuple type is homogeneous
 *  (all elements equal ⇒ lower to `seq`) vs heterogeneous (⇒ keep as `tuple`). */
export function tyEqual(a: Ty, b: Ty): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "array": return tyEqual(a.elem, (b as typeof a).elem);
    case "set":   return tyEqual(a.elem, (b as typeof a).elem);
    case "tuple": {
      const bt = b as typeof a;
      return a.elems.length === bt.elems.length && a.elems.every((e, i) => tyEqual(e, bt.elems[i]));
    }
    case "map": {
      const bm = b as typeof a;
      return tyEqual(a.key, bm.key) && tyEqual(a.value, bm.value);
    }
    case "optional": return tyEqual(a.inner, (b as typeof a).inner);
    case "user":     return a.name === (b as typeof a).name;
    case "fn": {
      const bf = b as typeof a;
      return a.params.length === bf.params.length
        && a.params.every((p, i) => tyEqual(p, bf.params[i]))
        && tyEqual(a.result, bf.result);
    }
    case "string": {
      const bs = b as typeof a;
      return JSON.stringify(a.values ?? null) === JSON.stringify(bs.values ?? null);
    }
    case "int": case "nat": return !!a.big === !!(b as typeof a).big;
    case "bool": case "real": case "void": case "unknown": return true;   // no payload
  }
}

export type CallKind = "pure" | "method" | "spec-pure" | "unknown"

/** Typed counterpart of RawChainStep. Carries the result-type at this step.
 *  `builtinId` is the builtin identity assigned once by resolve
 *  (DESIGN_LS_IN_LS.md §3): present iff `(receiver type kind, method name)`
 *  matched the registry at resolve time. Downstream passes read
 *  classification off the stamp instead of re-recognizing by spelling. */
export type TChainStep =
  | { kind: "field"; name: string; ty: Ty }
  | { kind: "call"; args: TExpr[]; ty: Ty; callKind: CallKind; builtinId?: BuiltinId }
  | { kind: "index"; idx: TExpr; ty: Ty };

// ── Expressions ──────────────────────────────────────────────

export type TExpr =
  | { kind: "var"; name: string; ty: Ty }
  | { kind: "num"; value: number; ty: Ty }
  | { kind: "bigint"; value: string; ty: Ty }   // exact integer, canonical decimal
  | { kind: "str"; value: string; ty: Ty }
  | { kind: "bool"; value: boolean; ty: Ty }
  | { kind: "binop"; op: string; left: TExpr; right: TExpr; ty: Ty }
  | { kind: "unop"; op: string; expr: TExpr; ty: Ty }
  | { kind: "call"; fn: TExpr; args: TExpr[]; ty: Ty; callKind: CallKind;
      builtinId?: BuiltinId;
      /** Resolved parameter types for a named callee. Kept so nominal
       *  backends can realize TypeScript structural argument conversions. */
      paramTys?: Ty[] }
  | { kind: "index"; obj: TExpr; idx: TExpr; ty: Ty }
  | { kind: "field"; obj: TExpr; field: string; ty: Ty;
      isDiscriminant?: boolean;             // true if this is a discriminant field access
      ofVariant?: string }                  // which union variant the field is read from, when narrowing determined it
  | { kind: "record"; spread: TExpr | null; fields: { name: string; value: TExpr }[]; ty: Ty }
  | { kind: "arrayLiteral"; elems: TExpr[]; ty: Ty }
  | { kind: "lambda"; params: { name: string; ty: Ty }[]; body: TStmt[]; ty: Ty }
  | { kind: "conditional"; cond: TExpr; then: TExpr; else: TExpr; ty: Ty }
  | { kind: "optChain"; obj: TExpr; chain: TChainStep[]; ty: Ty }
  | { kind: "nullish"; left: TExpr; right: TExpr; ty: Ty }
  | { kind: "someMatch"; scrutinee: TExpr; binder: string; binderTy: Ty;
      someBody: TExpr; noneBody: TExpr; ty: Ty }
  | { kind: "tagMatch"; scrutinee: TExpr; typeName: string;
      cases: { variant: string; body: TExpr }[];
      fallthrough: TExpr | null; ty: Ty }
  // Spec-only (from //@ annotations):
  // Note: \result is desugared by resolve.ts into a regular var named "\\result";
  // there is no kind: "result" variant in the typed IR.
  | { kind: "forall"; var: string; varTy: Ty; body: TExpr; ty: Ty }
  | { kind: "exists"; var: string; varTy: Ty; body: TExpr; ty: Ty }
  // Havoc — nondeterministic value:
  | { kind: "havoc"; ty: Ty }

// ── Statements ───────────────────────────────────────────────

export type TStmt =
  | { kind: "let"; name: string; ty: Ty; mutable: boolean; init: TExpr }
  | { kind: "assign"; target: string; value: TExpr }
  | { kind: "return"; value: TExpr }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "expr"; expr: TExpr }
  | { kind: "if"; cond: TExpr; then: TStmt[]; else: TStmt[] }
  | { kind: "while"; cond: TExpr;
      invariants: TExpr[];       // resolved from //@ annotation strings
      decreases: TExpr | null;
      doneWith: TExpr | null;
      body: TStmt[] }
  | { kind: "switch"; expr: TExpr; discriminant: string;
      // Labels are decoded source string-literal values.
      cases: { label: string; body: TStmt[] }[];
      defaultBody: TStmt[] }
  | { kind: "forof"; names: string[]; nameTypes: Ty[]; iterable: TExpr;
      invariants: TExpr[]; doneWith: TExpr | null; body: TStmt[] }
  | { kind: "throw" }
  | { kind: "ghostLet"; name: string; ty: Ty; init: TExpr }
  | { kind: "ghostAssign"; target: string; value: TExpr }
  | { kind: "assert"; expr: TExpr; assumed?: boolean }
  | { kind: "someMatch"; scrutinee: TExpr; binder: string; binderTy: Ty;
      someBody: TStmt[]; noneBody: TStmt[] }
  | { kind: "tagMatch"; scrutinee: TExpr; typeName: string;
      cases: { variant: string; body: TStmt[] }[];
      fallthrough: TStmt[] }

/** Statement kinds that unconditionally leave the enclosing block. Shared by
 *  resolve (block-tail narrowing) and narrow (isTerminating); works on raw and
 *  typed IR alike since both use these kind strings. */
export function isTerminatorKind(kind: string): boolean {
  return kind === "return" || kind === "throw" || kind === "break" || kind === "continue";
}

// ── Top-level ────────────────────────────────────────────────

export interface TParam {
  name: string;
  ty: Ty;
}

export interface TFunction {
  name: string;
  typeParams: string[];
  params: TParam[];
  returnTy: Ty;
  requires: TExpr[];
  ensures: TExpr[];
  decreases: TExpr | null;
  isPure: boolean;          // no while, no mutable let
  forcePure: boolean;       // //@ pure — emit function by method if body can't be pure
  autohavoc: boolean;       // //@ autohavoc — abstract unmodellable exprs to havoc
  body: TStmt[];
}

export interface TClass {
  name: string;
  fields: { name: string; ty: Ty }[];
  methods: TFunction[];
}

export interface TConst {
  name: string;
  ty: Ty;
  value: TExpr;
}

/** Resolved counterpart of RawExtern. */
export interface TExtern {
  qualified: string;
  flat: string;
  typeParams: string[];
  params: TParam[];
  returnTy: Ty;
  requires: TExpr[];
  ensures: TExpr[];
  impure: boolean;
}

export interface TModule {
  file: string;
  typeDecls: import("./types.js").TypeDeclInfo[];
  externs: TExtern[];
  constants: TConst[];
  functions: TFunction[];
  classes: TClass[];
}
