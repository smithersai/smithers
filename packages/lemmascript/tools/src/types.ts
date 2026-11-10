/**
 * Type mapping — TS types → Lean types.
 *
 * Single source of truth for type-related decisions.
 * The transform phase imports this.
 */

// ── Type info extracted from TS ──────────────────────────────

export interface FieldInfo {
  name: string;
  tsType: string;
  type?: Ty;     // pre-computed Ty — populated by resolveModule, avoids re-parsing tsType
}

export interface VariantInfo {
  name: string;
  fields: FieldInfo[];
}

export interface UnionTypeInfo {
  name: string;
  discriminant: string;
  variants: VariantInfo[];
}

export interface TypeDeclInfo {
  name: string;
  typeParams?: string[];
  kind: "string-union" | "discriminated-union" | "record" | "alias" | "opaque";
  /** For string unions: the literal values */
  values?: string[];
  /** For discriminated unions: the discriminant field and variants */
  discriminant?: string;
  variants?: VariantInfo[];
  /** For records: the fields */
  fields?: FieldInfo[];
  /** For alias: the underlying type string */
  aliasOf?: string;
  aliasOfTy?: Ty;  // pre-computed Ty for aliasOf
}

// ── TS type string → Ty (single source of truth) ───────────

import type { Ty } from "./typedir.js";
import { tyEqual } from "./typedir.js";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { Project as TsProject, SourceFile, TypeNode } from "ts-morph";

/**
 * Parses TS type strings via a real ts-morph parse — no regex cascade. Set
 * once per run by `extractModule` (so it reuses the module's Project); a
 * separate in-memory Project is created lazily for callers that hit
 * `parseTsType` outside the extract pipeline (e.g. tests, `lsc info` when
 * driven independently).
 */
let _synthFile: SourceFile | null = null;

export function initTypeParser(project: TsProject): void {
  _synthFile = project.createSourceFile("__lsc_type_parse__.ts", "", { overwrite: true });
}

function synthFile(): SourceFile {
  if (_synthFile) return _synthFile;
  const p = new Project({ useInMemoryFileSystem: true });
  _synthFile = p.createSourceFile("__lsc_type_parse__.ts", "");
  return _synthFile;
}

export function parseTsType(tsType: string): Ty {
  const sf = synthFile();
  sf.replaceWithText(`type __t = ${tsType};`);
  const alias = sf.getTypeAliasOrThrow("__t");
  return tyFromTypeNode(alias.getTypeNodeOrThrow());
}

function tyFromTypeNode(tn: TypeNode): Ty {
  if (Node.isParenthesizedTypeNode(tn)) return tyFromTypeNode(tn.getTypeNode());
  // `readonly T[]` / `readonly [A, B]` — the modifier is a TypeOperator wrapping
  // the array/tuple; verification treats it identically to the mutable form.
  if (Node.isTypeOperatorTypeNode(tn) && tn.getOperator() === SyntaxKind.ReadonlyKeyword) {
    return tyFromTypeNode(tn.getTypeNode());
  }
  if (Node.isUnionTypeNode(tn)) {
    const arms = tn.getTypeNodes();
    const isBoolLit = (a: TypeNode) =>
      Node.isLiteralTypeNode(a) && (a.getLiteral().getKind() === SyntaxKind.TrueKeyword || a.getLiteral().getKind() === SyntaxKind.FalseKeyword);
    const isNullish = (a: TypeNode) =>
      a.getKind() === SyntaxKind.NullKeyword ||
      a.getKind() === SyntaxKind.UndefinedKeyword ||
      (Node.isLiteralTypeNode(a) && a.getLiteral().getKind() === SyntaxKind.NullKeyword);
    // Collapse expanded boolean (`true | false`) into a single bool slot, so
    // `boolean | undefined` (which TS expands to `false | true | undefined`)
    // still reads as `optional<bool>` rather than falling through to user.
    const hasTrueLit = arms.some(a => Node.isLiteralTypeNode(a) && a.getLiteral().getKind() === SyntaxKind.TrueKeyword);
    const hasFalseLit = arms.some(a => Node.isLiteralTypeNode(a) && a.getLiteral().getKind() === SyntaxKind.FalseKeyword);
    const collapseBool = hasTrueLit && hasFalseLit;
    const normalized: ({ node: TypeNode } | { syntheticBool: true })[] =
      collapseBool
        ? [{ syntheticBool: true } as const, ...arms.filter(a => !isBoolLit(a)).map(node => ({ node }))]
        : arms.map(node => ({ node }));
    if (normalized.length === 1 && "syntheticBool" in normalized[0]) return { kind: "bool" };
    const nonNullish = normalized.filter(a => "syntheticBool" in a || !isNullish(a.node));
    // Inline string-literal union (`"a" | "b"`, not a //@ declare-type): no datatype
    // to resolve against, so lower to plain string (the arms are strings; == holds).
    const isStrLit = (a: { node: TypeNode } | { syntheticBool: true }) =>
      !("syntheticBool" in a) && Node.isLiteralTypeNode(a.node) && a.node.getLiteral().getKind() === SyntaxKind.StringLiteral;
    if (nonNullish.length >= 2 && nonNullish.every(isStrLit)) {
      // Keep the literal members so `rec[k]` can lower to an equality chain.
      const values = nonNullish.map(a => {
        const lit = (a as { node: TypeNode }).node;
        const inner = Node.isLiteralTypeNode(lit) ? lit.getLiteral() : lit;
        return Node.isStringLiteral(inner) ? inner.getLiteralValue() : inner.getText();
      });
      return normalized.some(a => !("syntheticBool" in a) && isNullish(a.node))
        ? { kind: "optional", inner: { kind: "string", values } }
        : { kind: "string", values };
    }
    if (nonNullish.length === 1 && normalized.length >= 2) {
      const sole = nonNullish[0];
      const inner: Ty = "syntheticBool" in sole ? { kind: "bool" } : tyFromTypeNode(sole.node);
      return { kind: "optional", inner };
    }
    // Multi-member union with a nullish arm (`A | B | undefined`): the
    // structured part is opaque to us, but the optionality isn't. Expose it as
    // optional<user "A | B"> so downstream (e.g. the let-type merge in resolve)
    // can keep the nullability while taking structure from a more precise
    // source. Without this the whole thing collapses to one opaque user blob.
    const hadNullish = normalized.some(a => !("syntheticBool" in a) && isNullish(a.node));
    if (hadNullish && nonNullish.length >= 2) {
      const innerName = nonNullish.map(a => ("syntheticBool" in a ? "boolean" : a.node.getText())).join(" | ");
      return { kind: "optional", inner: { kind: "user", name: innerName } };
    }
    // Other unions: leave as a user type spelled how the source wrote it.
    return { kind: "user", name: tn.getText() };
  }
  if (Node.isArrayTypeNode(tn)) return { kind: "array", elem: tyFromTypeNode(tn.getElementTypeNode()) };
  if (Node.isTupleTypeNode(tn)) {
    const elems = tn.getElements().map(tyFromTypeNode);
    if (elems.length === 0) return { kind: "array", elem: { kind: "unknown" } };
    // Homogeneous tuple → seq; only heterogeneous tuples need the tuple
    // representation.
    if (elems.every(e => tyEqual(e, elems[0]))) return { kind: "array", elem: elems[0] };
    return { kind: "tuple", elems };
  }
  if (Node.isFunctionTypeNode(tn)) {
    const params = tn.getParameters().map(p => {
      const ptn = p.getTypeNode();
      return ptn ? tyFromTypeNode(ptn) : { kind: "unknown" as const };
    });
    const result = tyFromTypeNode(tn.getReturnTypeNodeOrThrow());
    return { kind: "fn", params, result };
  }
  if (Node.isLiteralTypeNode(tn)) {
    const lk = tn.getLiteral().getKind();
    if (lk === SyntaxKind.TrueKeyword || lk === SyntaxKind.FalseKeyword) return { kind: "bool" };
  }
  switch (tn.getKind()) {
    case SyntaxKind.NumberKeyword:
      return { kind: "int" };
    case SyntaxKind.BigIntKeyword:
      return { kind: "int", big: true };
    case SyntaxKind.BooleanKeyword:
      return { kind: "bool" };
    case SyntaxKind.StringKeyword:
      return { kind: "string" };
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.UndefinedKeyword:
      return { kind: "void" };
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.AnyKeyword:
      return { kind: "unknown" };
  }
  if (Node.isTypeReference(tn)) {
    const name = tn.getTypeName().getText();
    const args = tn.getTypeArguments();
    if (name === "nat" && args.length === 0) return { kind: "nat" };
    if (name === "real" && args.length === 0) return { kind: "real" };
    if (name === "int" && args.length === 0) return { kind: "int" };
    if ((name === "Array" || name === "ReadonlyArray") && args.length === 1) return { kind: "array", elem: tyFromTypeNode(args[0]) };
    if (name === "Set" && args.length === 1) return { kind: "set", elem: tyFromTypeNode(args[0]) };
    if ((name === "Map" || name === "Record") && args.length === 2) {
      return { kind: "map", key: tyFromTypeNode(args[0]), value: tyFromTypeNode(args[1]) };
    }
    // User-named type: include generic args in the spelled name so callers
    // that key on the string (e.g. typedir alias lookups) see the exact form.
    return { kind: "user", name: tn.getText() };
  }
  return { kind: "user", name: tn.getText() };
}

/** Render a Ty in LemmaScript canonical syntax — backend-neutral, side-effect-free.
 *  Used by `lsc info` for the signature field of `foo.ts.json`. */
export function tyToCanonical(ty: Ty): string {
  switch (ty.kind) {
    case "bool":   return "bool";
    case "nat":    return "nat";
    case "int":    return "int";
    case "real":   return "real";
    case "string": return "string";
    case "void":   return "void";
    case "unknown":return "unknown";
    case "array":  return `seq<${tyToCanonical(ty.elem)}>`;
    case "tuple":  return `(${ty.elems.map(tyToCanonical).join(", ")})`;
    case "map":    return `map<${tyToCanonical(ty.key)}, ${tyToCanonical(ty.value)}>`;
    case "set":    return `set<${tyToCanonical(ty.elem)}>`;
    case "optional": return `Option<${tyToCanonical(ty.inner)}>`;
    case "user":   return ty.name;
    case "fn":     return `(${ty.params.map(tyToCanonical).join(", ")}) -> ${tyToCanonical(ty.result)}`;
  }
}

