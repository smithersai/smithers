/**
 * Extract — ts-morph → Raw IR.
 *
 * Produces structured AST nodes, not strings.
 * The only strings are //@ annotation expressions (parsed later by specparser).
 */

import { desugarMessageUnions } from "./message-union.js";
import { Project, Node, FunctionDeclaration, InterfaceDeclaration, SourceFile, TypeAliasDeclaration, Type, SyntaxKind, Expression, ElementAccessExpression, ScriptTarget, VariableDeclaration, ts } from "ts-morph";
import type { TypeDeclInfo, VariantInfo } from "./types.js";
import { initTypeParser } from "./types.js";
import type { RawExpr, RawStmt, RawFunction, RawModule, RawClass, RawConst, RawGhostLet, RawGhostAssign } from "./rawir.js";
import { normalizeBigIntLiteral } from "./rawir.js";
import { setUserNames, freshName } from "./names.js";
import { DEFAULT_OPTIONS, type LscOptions } from "./config.js";

// ── Expression extraction ────────────────────────────────────

/** When set, calls whose function/method name matches this key are replaced with havoc. */
let _havocKey: string | null = null;

/** A leading `//@ havoc`, `//@ havoc : Type`, or `//@ havoc <key>` directive. */
function havocDirective(s: Node): { type: string | null; key: string | null } | null {
  const m = s.getLeadingCommentRanges()
    .map(r => r.getText().trim().match(/^\/\/@ havoc(?:\s*:\s*(.+)|(?:\s+(\S+)))?$/))
    .find(m => m !== null);
  return m ? { type: m[1]?.trim() ?? null, key: m[2] ?? null } : null;
}

/** Run `fn` with `key` as the subexpression havoc key, restoring the outer one. */
function withHavocKey<T>(key: string | null, fn: () => T): T {
  const saved = _havocKey;
  if (key) _havocKey = key;
  try { return fn(); } finally { _havocKey = saved; }
}

/** Auto-detected cross-file calls. Populated by `extractExpr` whenever it sees
 *  a call `Obj.method(...)` or `foo(...)` whose ts-morph symbol resolves to a
 *  different `.ts` source file. Emitted in Dafny as `function {:axiom} <flat>`
 *  when effectively pure, or as a body-less method when effectively impure
 *  after project defaults and source overrides.
 *  Cleared at the start of every `extractModule`. */
const _externs = new Map<string, import("./rawir.js").RawExtern>();
/** Constants a copied cross-file contract names from its own module, by the name the contract reads. */
const _externContractConsts = new Map<string, VariableDeclaration>();
/** Signature types of *kept* externs, for the imported-type resolver: a type
 *  reachable ONLY through an imported function's signature (e.g. an extern
 *  returning PresentFact that no local signature mentions) must still be
 *  resolved into a full decl, or it synthesizes opaque. Filled only after the
 *  extern survives the `_externs` dedup — a cross-file signature superseded by a
 *  same-file `//@ extern` contributes nothing to the output, so resolving its
 *  types would emit decls that no emitted declaration mentions. */
const _externSigTypes: { type: Type; node: Node }[] = [];
let _currentSourceFile: SourceFile | null = null;
/** True only while extracting a function body. Module-level constants that
 *  reference cross-file callees (e.g., `BusEvent.define(...)` inside a
 *  module-level record) would otherwise pollute the output with externs
 *  that no verified function actually calls — and whose TS return types
 *  often don't translate to valid Dafny. */
let _inFunctionExtraction = false;
/** Effective options for the current extraction. Reset at extractModule entry. */
let _extractOptions: LscOptions = DEFAULT_OPTIONS;
/** The CLI validates source options before copying a cross-file contract. */
let _validateDependency: (source: SourceFile) => void = () => {};
/** Counter for synthetic names used by let-statement array destructuring
 *  when the initializer isn't a bare variable (single-eval temp). */
let _destrCounter = 0;

/** Register the call's callee as a cross-file extern if applicable, then
 *  walk the source declaration's body for nested calls outside the module being
 *  extracted (so the lifted `requires`/`ensures` see all the symbols they
 *  reference). A helper beside the callee, in the callee's own file, is such a
 *  call: nested calls are judged against `sourceFile`, the extracted module,
 *  never against the callee's file. Idempotent via the `_externs` dedup. */
function registerExternIfCrossFile(
  callee: import("ts-morph").PropertyAccessExpression | import("ts-morph").Identifier,
  sourceFile: SourceFile,
): void {
  const sigTypes: { type: Type; node: Node }[] = [];
  const ext = detectCrossFileExtern(callee, sourceFile, sigTypes);
  if (!ext || _externs.has(ext.qualified)) return;
  _externs.set(ext.qualified, ext);
  registerContractConstants(callee, ext, sourceFile);
  // Only now that the extern is kept do its signature types become resolver
  // seeds — see `_externSigTypes`.
  _externSigTypes.push(...sigTypes);
  // Recurse: scan the source decl's body for nested cross-file calls so any
  // symbol referenced by the copied spec is itself declared in the output.
  let symbol = callee.getSymbol();
  if (!symbol) return;
  const aliased = symbol.getAliasedSymbol();
  if (aliased) symbol = aliased;
  const sourceDecl = symbol.getDeclarations().find(
    d => d.getSourceFile().getFilePath() !== sourceFile.getFilePath(),
  );
  if (!sourceDecl) return;
  const body = (sourceDecl as any).getBody?.();
  if (!body) return;
  for (const inner of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const innerCallee = inner.getExpression();
    if (Node.isPropertyAccessExpression(innerCallee) || Node.isIdentifier(innerCallee)) {
      registerExternIfCrossFile(innerCallee, sourceFile);
    }
  }
}

/** A module-level const another module may copy: a non-function value with a type the extractor reads. */
function copyableConst(decl: VariableDeclaration): boolean {
  if (decl.getSourceFile().getFilePath().endsWith(".d.ts")) return false;
  const list = decl.getParent();
  if (!Node.isVariableDeclarationList(list) || !(list.getFlags() & 2 /* const */)) return false;
  if (!Node.isVariableStatement(list.getParent())) return false;
  const init = decl.getInitializer();
  if (!init || Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return false;
  return !typeToString(decl.getType()).startsWith("__");
}

/** A copied contract keeps the meaning it has in its own module: every module-level constant of that module it
 *  names (not as a field) is declared beside it, as `importedConstants` declares a named import. */
function registerContractConstants(
  callee: import("ts-morph").PropertyAccessExpression | import("ts-morph").Identifier,
  ext: import("./rawir.js").RawExtern,
  sourceFile: SourceFile,
): void {
  let symbol = callee.getSymbol();
  const aliased = symbol?.getAliasedSymbol();
  if (aliased) symbol = aliased;
  const home = symbol?.getDeclarations().find(d => d.getSourceFile().getFilePath() !== sourceFile.getFilePath())?.getSourceFile();
  if (!home) return;
  const text = [...ext.requires, ...ext.ensures].join("\n");
  for (const statement of home.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const name = decl.getName();
      if (!new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)) continue;
      if (copyableConst(decl)) {
        const prior = _externContractConsts.get(name);
        if (prior && prior !== decl) {
          throw new Error(`imported const '${name}' from ${home.getBaseName()} collides with another contract's constant in ${prior.getSourceFile().getBaseName()}`);
        }
        _externContractConsts.set(name, decl);
      }
    }
  }
}

/** Whether `name` in `sourceFile` is `decl` itself, declared or imported by name. */
function sameConstant(sourceFile: SourceFile, name: string, decl: VariableDeclaration): boolean {
  for (const imp of sourceFile.getImportDeclarations()) {
    for (const spec of imp.getNamedImports()) {
      const local = spec.getAliasNode() ?? spec.getNameNode();
      if (local.getText() === name && crossFileConst(local, sourceFile.getFilePath()) === decl) return true;
    }
  }
  return false;
}

/** The const declaration an identifier names, when it lives in another module. */
function crossFileConst(id: Node, currentPath: string): VariableDeclaration | undefined {
  let symbol = id.getSymbol();
  const aliased = symbol?.getAliasedSymbol();
  if (aliased) symbol = aliased;
  const decl = symbol?.getDeclarations().find(Node.isVariableDeclaration);
  if (!decl || decl.getSourceFile().getFilePath() === currentPath) return undefined;
  if (decl.getSourceFile().getFilePath().endsWith(".d.ts")) return undefined;
  const list = decl.getParent();
  if (!Node.isVariableDeclarationList(list) || !(list.getFlags() & 2 /* const */)) return undefined;
  const init = decl.getInitializer();
  if (!init || Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return undefined;
  if (typeToString(decl.getType()).startsWith("__")) return undefined;
  return decl;
}

/** Constants a module imports by name from other modules, with the constants
 *  their initializers read, in dependency order. Each is copied under the name
 *  it is read by (`import { A as B }` declares `B`), so a contract or body that
 *  reads it resolves to the declared value. A copied name that collides with a
 *  different constant is refused rather than merged. */
function importedConstants(sourceFile: SourceFile, localNames: ReadonlySet<string>,
  named = true, extra: ReadonlyMap<string, VariableDeclaration> = new Map()): RawConst[] {
  const currentPath = sourceFile.getFilePath();
  const out: RawConst[] = [];
  const copied = new Map<string, VariableDeclaration>();
  const copy = (name: string, decl: VariableDeclaration): void => {
    const prior = copied.get(name);
    if (prior === decl) return;
    if (!prior && localNames.has(name) && sameConstant(sourceFile, name, decl)) return;
    if (prior || localNames.has(name)) {
      throw new Error(`imported const '${name}' from ${decl.getSourceFile().getBaseName()} collides with another constant of that name in ${sourceFile.getBaseName()}`);
    }
    copied.set(name, decl);
    _validateDependency(decl.getSourceFile());
    const init = decl.getInitializerOrThrow();
    for (const id of init.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const dep = crossFileConst(id, currentPath);
      if (dep) copy(id.getText(), dep);
    }
    out.push({ name, tsType: typeToString(decl.getType()), value: extractExpr(init as Expression) });
  };
  for (const imp of named ? sourceFile.getImportDeclarations() : []) {
    if (imp.isTypeOnly()) continue;
    for (const spec of imp.getNamedImports()) {
      if (spec.isTypeOnly()) continue;
      const local = spec.getAliasNode() ?? spec.getNameNode();
      const decl = crossFileConst(local, currentPath);
      if (decl) copy(local.getText(), decl);
    }
  }
  for (const [name, decl] of extra) copy(name, decl);
  return out;
}

function detectCrossFileExtern(
  callee: import("ts-morph").PropertyAccessExpression | import("ts-morph").Identifier,
  sourceFile: SourceFile,
  sigTypesOut: { type: Type; node: Node }[],
): import("./rawir.js").RawExtern | null {
  let symbol = callee.getSymbol();
  if (!symbol) return null;
  // For bare imports `import { foo } from "..."`, the call-site symbol is the
  // local ImportSpecifier — declared in the current file. Follow the alias to
  // the original `export function` declaration.
  const aliased = symbol.getAliasedSymbol();
  if (aliased) symbol = aliased;
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;
  const currentPath = sourceFile.getFilePath();
  // A declaration in the current file is authoritative — don't resolve to a
  // same-named definition in another file.
  if (decls.some(d => d.getSourceFile().getFilePath() === currentPath)) return null;
  const externalDecl = decls.find(d => d.getSourceFile().getFilePath() !== currentPath);
  if (!externalDecl) return null;
  // Skip stdlib / typings — those have built-in dispatch elsewhere or are
  // genuinely out of LS's verification model.
  if (externalDecl.getSourceFile().getFilePath().endsWith(".d.ts")) return null;
  const sig = callee.getType().getCallSignatures()[0];
  if (!sig) return null;
  // Includes global declarations selected by TypeScript without an import edge.
  _validateDependency(externalDecl.getSourceFile());
  // Generic type parameters (e.g. `step<S, A>`). ts-morph reports param/return
  // types in the callee's own type-parameter namespace, so these names match
  // what `params`/`returnType` reference — declare them on the emitted axiom.
  const typeParams = sig.getTypeParameters().map(tp => tp.getText());
  // Print types relative to the call site (enclosingNode = callee, alias names
  // kept): a bare `TMsg`, not `import("/abs/path/transcript").TMsg` — the
  // importing module declares the datatype locally, so the axiom must use the
  // local name.
  // NoTruncation: a wide expansion (e.g. an alias for a large string-literal
  // union, not importable at the call site) must print whole — a truncated
  // union is unparseable and synthesizes an opaque decl named by its own text.
  const externTypeText = (t: Type) =>
    t.getText(callee, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.NoTruncation);
  const params = sig.getParameters().map(p => ({
    name: p.getName(),
    tsType: externTypeText(p.getTypeAtLocation(callee)),
  }));
  const returnType = externTypeText(sig.getReturnType());
  for (const p of sig.getParameters()) {
    sigTypesOut.push({ type: p.getTypeAtLocation(callee), node: callee });
  }
  sigTypesOut.push({ type: sig.getReturnType(), node: callee });
  // Also seed from the source declaration's syntactic type nodes: symbol-based
  // types can drop the alias symbol (the printed signature then names an alias
  // like `TypeDecls` that would otherwise synthesize opaque), while a type
  // node's type keeps it.
  const srcDecl = externalDecl as { getParameters?: () => { getTypeNode?: () => Node | undefined }[]; getReturnTypeNode?: () => Node | undefined };
  for (const sp of srcDecl.getParameters?.() ?? []) {
    const tn = sp.getTypeNode?.();
    if (tn) sigTypesOut.push({ type: tn.getType(), node: tn });
  }
  const rtn = srcDecl.getReturnTypeNode?.();
  if (rtn) sigTypesOut.push({ type: rtn.getType(), node: rtn });
  let qualified: string;
  if (Node.isPropertyAccessExpression(callee)) {
    qualified = `${callee.getExpression().getText()}.${callee.getName()}`;
  } else {
    qualified = callee.getText();
  }
  const flat = qualified.replace(/\./g, "_");
  // Lift `//@ requires`/`//@ ensures` from the source declaration so callers
  // reason against the source's verified contract, not an unconstrained axiom.
  const annots = collectFunctionAnnotations(externalDecl);
  const requires = annots.filter(a => a.kind === "requires").map(a => a.expr);
  const ensures = annots.filter(a => a.kind === "ensures").map(a => a.expr);
  const impure = externIsImpure(externalDecl, qualified);
  return { qualified, flat, typeParams, params, returnType, requires, ensures, impure };
}

/** `...(c ? { a: 1 } : { b: 2 })`: both branches must be plain named-field object
 *  literals. Each named field becomes a conditional over the spread's accumulator.
 *  Anything else stays a `recordMerge`. */
function conditionalSpreadBranches(node: Node): { cond: RawExpr; names: string[]; then: Map<string, RawExpr>; else: Map<string, RawExpr> } | null {
  let expr = node;
  while (Node.isParenthesizedExpression(expr)) expr = expr.getExpression();
  if (!Node.isConditionalExpression(expr)) return null;
  const literal = (branch: Node): Map<string, RawExpr> | null => {
    let e = branch;
    while (Node.isParenthesizedExpression(e)) e = e.getExpression();
    if (!Node.isObjectLiteralExpression(e)) return null;
    const out = new Map<string, RawExpr>();
    for (const prop of e.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) out.set(prop.getName(), { kind: "var", name: prop.getName() });
      else if (Node.isPropertyAssignment(prop) && !Node.isComputedPropertyName(prop.getNameNode()) && prop.getInitializer()) {
        out.set(prop.getName(), extractExpr(prop.getInitializer()!));
      } else return null;
    }
    return out;
  };
  const whenTrue = literal(expr.getWhenTrue());
  const whenFalse = literal(expr.getWhenFalse());
  if (!whenTrue || !whenFalse) return null;
  return { cond: extractExpr(expr.getCondition()), names: [...new Set([...whenTrue.keys(), ...whenFalse.keys()])], then: whenTrue, else: whenFalse };
}

/** `X.match(value, { Tag: ({ field }) => result, … })` in return position, where the
 *  table names exactly the `_tag` values of `value`'s union: read as a `switch`. */
function taggedMatchStatement(node: Node, line: number): RawStmt | null {
  if (!Node.isCallExpression(node)) return null;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "match") return null;
  const args = node.getArguments();
  if (args.length !== 2) return null;
  const [valueNode, table] = args;
  if (!Node.isObjectLiteralExpression(table)) return null;
  const members = (valueNode as Expression).getType().getUnionTypes();
  const tags = members.map(m => m.getProperty("_tag")?.getTypeAtLocation(valueNode));
  if (members.length === 0 || tags.some(t => !t?.isStringLiteral())) return null;
  const expected = new Set(tags.map(t => t!.getLiteralValue() as string));
  const arms = table.getProperties();
  if (arms.length !== expected.size) return null;
  const scrutinee = extractExpr(valueNode as Expression);
  const cases: { label: string; body: RawStmt[] }[] = [];
  for (const arm of arms) {
    if (!Node.isPropertyAssignment(arm) || !expected.has(arm.getName())) return null;
    const fn = arm.getInitializer();
    if (!fn || !Node.isArrowFunction(fn)) return null;
    const params = fn.getParameters();
    if (params.length > 1) return null;
    const body: RawStmt[] = [];
    if (params.length === 1) {
      const pattern = params[0]!.getNameNode();
      if (!Node.isObjectBindingPattern(pattern)) throw new Error(`Tagged match arm ${arm.getName()} at line ${line}: destructure the message in the parameter`);
      for (const element of pattern.getElements()) {
        if (element.getDotDotDotToken()) throw new Error(`Tagged match arm ${arm.getName()} at line ${line}: rest binding is not supported`);
        const field = element.getPropertyNameNode()?.getText() ?? element.getName();
        const read: RawExpr = { kind: "field", obj: scrutinee, field };
        const fallback = element.getInitializer();
        body.push({
          kind: "let", name: element.getName(), mutable: false, tsType: typeToString(element.getType()),
          init: fallback ? { kind: "nullish", left: read, right: extractExpr(fallback) } : read, line,
        });
      }
    }
    const result = fn.getBody();
    if (Node.isBlock(result)) body.push(...extractStmts(result.getStatements()));
    else body.push({ kind: "return", value: extractExpr(result as Expression), line });
    cases.push({ label: arm.getName(), body });
  }
  return { kind: "switch", expr: scrutinee, discriminant: "_tag", cases, defaultBody: [], line };
}

/** Build a concat-tree from a mixed list of literal and SpreadElement nodes.
 *  Literals collapse into arrayLiteral segments; spreads become bare expressions;
 *  segments are joined with `arrayConcat`. Used by array-literal and Math.max/min
 *  call-arg spread.
 *  Precondition: at least one element. */
function buildSpreadConcat(elems: readonly Node[]): RawExpr {
  const segments: RawExpr[] = [];
  let currentLiterals: RawExpr[] = [];
  for (const e of elems) {
    if (Node.isSpreadElement(e)) {
      if (currentLiterals.length > 0) {
        segments.push({ kind: "arrayLiteral", elems: currentLiterals });
        currentLiterals = [];
      }
      segments.push(extractExpr(e.getExpression()));
    } else {
      currentLiterals.push(extractExpr(e as Expression));
    }
  }
  if (currentLiterals.length > 0) {
    segments.push({ kind: "arrayLiteral", elems: currentLiterals });
  }
  let result = segments[0];
  for (let i = 1; i < segments.length; i++) {
    result = { kind: "binop", op: "arrayConcat", left: result, right: segments[i] };
  }
  return result;
}

/**
 * Maps property-name fingerprints to type alias names for collapsed single-variant unions.
 * TypeScript collapses `type X = | { kind: 'A'; ... }` to the underlying object type,
 * causing getAliasSymbol() to return null. This map lets typeToString recover the alias.
 * Populated in extractModule before type extraction; used by typeToString.
 */
let _collapsedUnionMap: Map<string, string> = new Map();

/**
 * Accumulator for synthesized `T[] | U` array-union datatypes.
 *
 * Plain TS unions like `string | Part[]` have no backend image (LemmaScript
 * models tagged unions only). When typeToString encounters a binary union
 * where one member is an array and the other is not array/undefined/null,
 * it synthesizes a discriminated-union TypeDeclInfo with variants
 * ArrayBranch(arr: T[]) and NonArrayBranch(val: U) and returns the synthetic
 * name in place of "T[] | U". The runtime discriminator is `Array.isArray`,
 * lowered to a tag predicate by narrow/transform.
 *
 * Set in extractModule to the module's typeDecls; cleared at end. When null,
 * typeToString falls through to the existing union path.
 */
let _synthArrayUnions: TypeDeclInfo[] | null = null;

/** Sanitize an arbitrary type-string fragment for use inside a generated identifier. */
function _synthName(elemName: string, otherName: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `ArrayOf_${sanitize(elemName)}_Or_${sanitize(otherName)}`;
}

/**
 * Fall-through for a union LS can't model as a tagged union (no runtime type
 * test maps to a tag — e.g. members are unreachable imports with no visible
 * discriminant). Registers an opaque-type TypeDeclInfo and returns its name, so
 * the union becomes one abstract `type` rather than invalid raw-union Dafny.
 *
 * Sound because an opaque type has no constructor and no tag predicate: any
 * attempt to build or type-test the value fails to lower, so it can only be
 * passed through — the one sound use of a union we can't discriminate. Distinct
 * from dropping the field (which collapses values and is unsound): the value is
 * preserved, just uninspectable.
 */
function _synthOpaque(memberNames: string[]): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `Opaque_${memberNames.map(sanitize).join("_or_")}`;
  if (_synthArrayUnions !== null && !_synthArrayUnions.some(d => d.name === name)) {
    _synthArrayUnions.push({ name, kind: "opaque" });
  }
  return name;
}

/**
 * String-level fallback for synth detection on a `T[] | U` shape, used by
 * declare-type field parsing (where no ts-morph TypeNode is available). The
 * format inside declare-type is user-controlled and structurally simple, so
 * a split-on-` | ` is acceptable in that bounded context. Returns the synth
 * name if matched, registers a TypeDeclInfo into the accumulator, else null.
 */
function _synthFromTsTypeString(ts: string): string | null {
  if (_synthArrayUnions === null) return null;
  if (!ts.includes(" | ")) return null;
  const arms = ts.split(" | ").map(s => s.trim());
  if (arms.length !== 2) return null;
  if (arms.some(a => a === "undefined" || a === "null")) return null;
  const arrIdx = arms.findIndex(a => a.endsWith("[]"));
  if (arrIdx === -1) return null;
  const otherIdx = 1 - arrIdx;
  if (arms[otherIdx].endsWith("[]")) return null;
  const elem = arms[arrIdx].slice(0, -2);
  const other = arms[otherIdx];
  const synthName = _synthName(elem, other);
  if (!_synthArrayUnions.some(d => d.name === synthName)) {
    _synthArrayUnions.push({
      name: synthName,
      kind: "discriminated-union",
      discriminant: "__isArray__",
      variants: [
        { name: "ArrayBranch", fields: [{ name: "arr", tsType: `${elem}[]` }] },
        { name: "NonArrayBranch", fields: [{ name: "val", tsType: other }] },
      ],
    });
  }
  return synthName;
}

/**
 * Compute a tsType string from a syntactic union TypeNode (`T | U`), preserving
 * the member nodes' source text (so `type ListId = number` stays `ListId`,
 * which ts-morph erases when you read the resolved Type). When the union matches
 * the `T[] | U` synth shape (U not array/undefined/null), registers a synth-
 * array-union TypeDeclInfo and returns its synthetic name. Otherwise returns
 * the syntactic join (so `ListId | undefined` stays a recognizable union for
 * parseTsType to wrap as Option<ListId>).
 *
 * This is the param/return-type counterpart of the typeToString synthesis hook,
 * which handles record/interface field types via the Type-driven path.
 */
function _tsTypeFromUnionNode(tn: Node): string {
  if (!Node.isUnionTypeNode(tn)) return tn.getText();
  const members = tn.getTypeNodes();
  if (_synthArrayUnions !== null && members.length === 2) {
    const arrIdx = members.findIndex(m => m.getType().isArray());
    if (arrIdx !== -1) {
      const other = members[1 - arrIdx];
      const ot = other.getType();
      if (!ot.isArray() && !ot.isUndefined() && !ot.isNull()) {
        const arrNode = members[arrIdx];
        const elemName = Node.isArrayTypeNode(arrNode)
          ? arrNode.getElementTypeNode().getText()
          : typeToString(arrNode.getType().getArrayElementTypeOrThrow());
        const otherName = other.getText();
        const synthName = _synthName(elemName, otherName);
        if (!_synthArrayUnions.some(d => d.name === synthName)) {
          _synthArrayUnions.push({
            name: synthName,
            kind: "discriminated-union",
            discriminant: "__isArray__",
            variants: [
              { name: "ArrayBranch", fields: [{ name: "arr", tsType: `${elemName}[]` }] },
              { name: "NonArrayBranch", fields: [{ name: "val", tsType: otherName }] },
            ],
          });
        }
        return synthName;
      }
    }
  }
  return members.map(m => m.getText()).join(" | ");
}

/** Generic bounds erasure map — set during extractFunction, applied in extractStmts. */
let _typeParamMap: Map<string, string> = new Map();

// Fresh for-counter names allocated in the current function — so two sibling
// loops that both need renaming don't independently pick the same `<name>_N`
// (detection is read-only, so the source still shows the original names).
let _reservedForCounterNames = new Set<string>();
function _eraseGenerics(tsType: string): string {
  if (_typeParamMap.size === 0) return tsType;
  if (tsType.includes(" | ")) {
    const arms = [...new Set(tsType.split(" | ").map(a => _eraseGenerics(a.trim())))];
    return arms.length === 1 ? arms[0] : arms.join(" | ");
  }
  if (tsType.endsWith("[]")) return _eraseGenerics(tsType.slice(0, -2)) + "[]";
  if (_typeParamMap.has(tsType)) return _typeParamMap.get(tsType)!;
  // Inside a type expression (`ReadonlyArray<T>`, `readonly T[]`, `Map<K, T>`,
  // `[T, number]`) the parameter is one identifier token. Leave property names
  // (`{ T: number }`) and qualified names (`NS.T`) alone.
  return tsType.replace(/[A-Za-z_$][\w$]*/g, (token, offset: number, text: string) => {
    const bound = _typeParamMap.get(token);
    if (bound === undefined) return token;
    if (text[offset - 1] === "." || /^\s*\??\s*:/.test(text.slice(offset + token.length))) return token;
    return bound;
  });
}

function extractExpr(node: Expression): RawExpr {
  // Havoc key matching: replace matching calls or new expressions with havoc expression
  if (_havocKey && (Node.isCallExpression(node) || Node.isNewExpression(node))) {
    const fnExpr = node.getExpression();
    const name = Node.isPropertyAccessExpression(fnExpr) ? fnExpr.getName()
      : Node.isIdentifier(fnExpr) ? fnExpr.getText()
      : null;
    if (name === _havocKey) {
      // Prefer the contextual type: the abstracted value stands in where the
      // surrounding code expects it, and a subclass (`new SdkError` into an
      // `Error` field) has no subtyping relation once both are opaque.
      const ty = node.getContextualType() ?? node.getType();
      return { kind: "havoc", tsType: typeToString(ty) };
    }
  }

  // Numeric literal
  if (Node.isNumericLiteral(node)) {
    return { kind: "num", value: Number(node.getLiteralValue()) };
  }

  // BigInt literal (e.g. 32n, 0xffffn) — exact integer, with bigint division
  // semantics. Kept as a decimal string: `getLiteralValue()`/`Number()` would
  // round anything past 2^53 (`9007199254740993n` → `9007199254740992`).
  if (Node.isBigIntLiteral(node)) {
    return { kind: "bigint", value: normalizeBigIntLiteral(node.getText()) };
  }

  // Template literal: `foo${x}bar` → "foo" + x + "bar"
  if (Node.isTemplateExpression(node)) {
    const parts: RawExpr[] = [];
    // Always push the head, even when empty: a leading string literal anchors the
    // whole chain as string-typed so each interpolated value is stringified (not
    // added numerically — `${a}${b}` is concatenation, not `a + b`).
    parts.push(stringLiteral(node.getHead().getLiteralText(), node));
    for (const span of node.getTemplateSpans()) {
      parts.push(extractExpr(span.getExpression()));
      const text = span.getLiteral().getLiteralText();
      if (text) parts.push(stringLiteral(text, span));
    }
    return parts.reduce((left, right) => ({ kind: "binop", op: "+", left, right }));
  }

  // No-substitution template literal: `hello` → "hello"
  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return stringLiteral(node.getLiteralText(), node);
  }

  // String literal
  if (Node.isStringLiteral(node)) {
    return stringLiteral(node.getLiteralValue(), node);
  }

  // Boolean literals: true, false
  if (Node.isTrueLiteral(node)) return { kind: "bool", value: true };
  if (Node.isFalseLiteral(node)) return { kind: "bool", value: false };

  // Identifier
  if (Node.isIdentifier(node)) {
    return { kind: "var", name: node.getText() };
  }

  // this
  if (node.getKind() === SyntaxKind.ThisKeyword) {
    return { kind: "var", name: "this" };
  }

  // Property access: x.foo or x?.foo
  // Each `?.` is its own short-circuit point — wrap the inner in a new optChain.
  // Non-`?` continuation of an existing optChain extends the chain (no new
  // short-circuit, just keep evaluating after the prior `?` succeeded).
  if (Node.isPropertyAccessExpression(node)) {
    const obj = extractExpr(node.getExpression());
    const field = node.getName();
    if (node.hasQuestionDotToken()) {
      return { kind: "optChain", obj, chain: [{ kind: "field", name: field }] };
    }
    if (obj.kind === "optChain") {
      return { ...obj, chain: [...obj.chain, { kind: "field", name: field }] };
    }
    return { kind: "field", obj, field };
  }

  // Element access: arr[i] or arr?.[i]
  if (Node.isElementAccessExpression(node)) {
    const arg = node.getArgumentExpression();
    if (!arg) throw new Error(`Missing index in element access: ${node.getText()}`);
    const obj = extractExpr(node.getExpression());
    const idx = extractExpr(arg);
    if (node.hasQuestionDotToken()) {
      return { kind: "optChain", obj, chain: [{ kind: "index", idx }] };
    }
    if (obj.kind === "optChain") {
      return { ...obj, chain: [...obj.chain, { kind: "index", idx }] };
    }
    return { kind: "index", obj, idx };
  }

  // Call expression: f(a, b), x?.foo() (`?.` on the property), or x?.() (`?.` on call)
  if (Node.isCallExpression(node)) {
    // Object.fromEntries(map) → identity (Map IS Record in Dafny)
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee) &&
        callee.getExpression().getText() === "Object" &&
        callee.getName() === "fromEntries" &&
        node.getArguments().length === 1) {
      return extractExpr(node.getArguments()[0] as Expression);
    }
    // Math.max(...) / Math.min(...) with spread args → MaxOfSeq(seq) / MinOfSeq(seq)
    // The spread is desugared at extract time; resolve and downstream passes
    // see an ordinary function call.
    if (Node.isPropertyAccessExpression(callee) &&
        callee.getExpression().getText() === "Math" &&
        (callee.getName() === "max" || callee.getName() === "min")) {
      const argNodes = node.getArguments();
      if (argNodes.some(a => Node.isSpreadElement(a))) {
        const combined = buildSpreadConcat(argNodes);
        const fnName = callee.getName() === "max" ? "MaxOfSeq" : "MinOfSeq";
        return { kind: "call", fn: { kind: "var", name: fnName }, args: [combined] };
      }
    }
    // Auto-extern: if the callee resolves (via ts-morph) to a symbol declared
    // in a different `.ts` file, register it as an opaque extern. Covers both
    // `Obj.method(...)` and bare `foo(...)` imports. Skipped for stdlib/.d.ts
    // declarations — those are either built-in methods (handled in dafny-emit)
    // or genuinely out of scope.
    if (_currentSourceFile && _inFunctionExtraction &&
        (Node.isPropertyAccessExpression(callee) || Node.isIdentifier(callee))) {
      registerExternIfCrossFile(callee, _currentSourceFile);
    }
    const fn = extractExpr(callee);
    const args = node.getArguments().map(a => extractExpr(a as Expression));
    if (node.hasQuestionDotToken()) {
      return { kind: "optChain", obj: fn, chain: [{ kind: "call", args }] };
    }
    if (fn.kind === "optChain") {
      return { ...fn, chain: [...fn.chain, { kind: "call", args }] };
    }
    return { kind: "call", fn, args };
  }

  // Binary expression: a + b, a === b, etc.
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getText();
    // Assignment: a = b → handled at statement level, but can appear in expressions
    if (op === "=") {
      // This is an assignment expression; extract as binop for now
      return { kind: "binop", op: "=", left: extractExpr(node.getLeft()), right: extractExpr(node.getRight()) };
    }
    // Nullish coalescing: a ?? b — single-eval, narrow rewrites to someMatch
    if (op === "??") {
      return { kind: "nullish", left: extractExpr(node.getLeft()), right: extractExpr(node.getRight()) };
    }
    return { kind: "binop", op, left: extractExpr(node.getLeft()), right: extractExpr(node.getRight()) };
  }

  // Prefix unary: !x, -x
  if (Node.isPrefixUnaryExpression(node)) {
    const opToken = node.getOperatorToken();
    let op: string;
    switch (opToken) {
      case SyntaxKind.ExclamationToken: op = "!"; break;
      case SyntaxKind.MinusToken: op = "-"; break;
      case SyntaxKind.PlusToken: op = "+"; break;
      default: op = String(opToken);
    }
    return { kind: "unop", op, expr: extractExpr(node.getOperand()) };
  }

  // Parenthesized: (x)
  if (Node.isParenthesizedExpression(node)) {
    return extractExpr(node.getExpression());
  }

  // Arrow function: (x) => expr or (x) => { stmts }
  if (Node.isArrowFunction(node)) {
    // A binding pattern is not an identifier in either backend. Keep the
    // callback arity unchanged by replacing a flat object pattern with one
    // synthetic parameter and binding its fields at the start of the body:
    //   ({ x, y: z }) => e
    // becomes, in Raw IR, the equivalent of
    //   (_lambdaParam0) => { const x = _lambdaParam0.x;
    //                        const z = _lambdaParam0.y; return e; }
    // transform's lambda flattener later turns these immutable lets back into
    // the expression form required by Dafny lambdas. More involved binding
    // semantics stay explicit errors rather than leaking pattern text into a
    // generated backend identifier.
    const destructureBindings: RawStmt[] = [];
    const params = node.getParameters().map((p, paramIndex) => {
      const typeNode = p.getTypeNode();
      const tsType = typeNode ? typeNode.getText() : undefined;
      const nameNode = p.getNameNode();
      if (Node.isIdentifier(nameNode)) return { name: nameNode.getText(), tsType };
      if (Node.isArrayBindingPattern(nameNode)) {
        throw new Error(`array binding pattern in arrow parameter not yet supported: ${nameNode.getText()}`);
      }
      if (!Node.isObjectBindingPattern(nameNode)) {
        throw new Error(`unsupported arrow parameter binding: ${p.getName()}`);
      }
      if (p.getInitializer()) {
        throw new Error(`defaulted object binding pattern in arrow parameter not yet supported: ${p.getText()}`);
      }

      const paramName = freshName(`_lambdaParam${paramIndex}`);
      for (const el of nameNode.getElements()) {
        if (el.getDotDotDotToken()) {
          throw new Error(`rest property in arrow parameter destructuring not yet supported: ${el.getText()}`);
        }
        if (el.getInitializer()) {
          throw new Error(`default value in arrow parameter destructuring not yet supported: ${el.getText()}`);
        }
        const localNode = el.getNameNode();
        if (!Node.isIdentifier(localNode)) {
          throw new Error(`nested binding pattern in arrow parameter destructuring not yet supported: ${el.getText()}`);
        }
        const localName = localNode.getText();
        const propNode = el.getPropertyNameNode();
        if (propNode && !Node.isIdentifier(propNode)) {
          throw new Error(`computed or literal property in arrow parameter destructuring not yet supported: ${el.getText()}`);
        }
        destructureBindings.push({
          kind: "let",
          name: localName,
          mutable: false,
          tsType: null,
          init: {
            kind: "field",
            obj: { kind: "var", name: paramName },
            field: propNode ? propNode.getText() : localName,
          },
          line: p.getStartLineNumber(),
        });
      }
      return { name: paramName, tsType };
    });
    // Return type from the checker — inferred when unannotated — so resolve can
    // type return-position record literals and give the lambda a real fn type.
    const returnTsType = typeToString(node.getReturnType());
    const body = node.getBody();
    if (Node.isExpression(body)) {
      const expr = extractExpr(body);
      const loweredBody = destructureBindings.length === 0
        ? expr
        : [...destructureBindings, { kind: "return" as const, value: expr, line: body.getStartLineNumber() }];
      return { kind: "lambda", params, body: loweredBody, returnTsType };
    }
    if (Node.isBlock(body)) {
      return { kind: "lambda", params, body: [...destructureBindings, ...extractStmts(body.getStatements())], returnTsType };
    }
    throw new Error(`Unsupported arrow function body: ${node.getText().slice(0, 80)}`);
  }

  // Array literal: [a, b, c] → arrayLiteral, with spreads → concatenation
  if (Node.isArrayLiteralExpression(node)) {
    const elems = node.getElements();
    const hasSpread = elems.some(e => Node.isSpreadElement(e));
    if (!hasSpread) {
      return { kind: "arrayLiteral", elems: elems.map(e => extractExpr(e as Expression)) };
    }
    // [a, ...b, c] → [a] + b + [c] via shared helper
    const result = buildSpreadConcat(elems);
    return result;
  }

  // Object literal: { res: true, done: false } or { ...obj, res: true }
  if (Node.isObjectLiteralExpression(node)) {
    // Fold properties in source order: a spread on top of existing content is a
    // field-wise merge (resolve expands it against the result type), a named field
    // is a record-update on the accumulator, a computed key is a map `.set`.
    let acc: RawExpr | null = null;
    const update = (name: string, value: RawExpr) => {
      acc = acc && acc.kind === "record"
        ? { kind: "record", spread: acc.spread, fields: [...acc.fields, { name, value }] }
        : { kind: "record", spread: acc, fields: [{ name, value }] };
    };
    for (const prop of node.getProperties()) {
      if (Node.isSpreadAssignment(prop)) {
        const branches = acc === null ? null : conditionalSpreadBranches(prop.getExpression());
        if (branches) {
          for (const name of branches.names) {
            // Project a partial literal directly: a field explicitly built so
            // far retains its value; a genuinely absent field is undefined.
            // Building an incomplete generic constructor just to project an
            // absent field leaves unrelated type parameters unconstrained.
            const prior = acc as RawExpr;
            const previousField = (): RawExpr => {
              if (prior.kind === "record") {
                const known = [...prior.fields].reverse().find(f => f.name === name);
                if (known) return known.value;
                if (!prior.spread) return { kind: "var", name: "undefined" };
                return { kind: "field", obj: prior.spread, field: name };
              }
              return { kind: "field", obj: prior, field: name };
            };
            const fieldOf = (literal: Map<string, RawExpr>): RawExpr =>
              literal.get(name) ?? previousField();
            update(name, { kind: "conditional", cond: branches.cond, then: fieldOf(branches.then), else: fieldOf(branches.else) });
          }
          continue;
        }
        const s = extractExpr(prop.getExpression());
        acc = acc === null ? s : { kind: "recordMerge", base: acc, override: s };
      } else if (Node.isShorthandPropertyAssignment(prop)) {
        const name = prop.getName();
        update(name, { kind: "var", name });
      } else if (Node.isPropertyAssignment(prop)) {
        const nameNode = prop.getNameNode();
        const init = prop.getInitializer();
        if (!init) continue;
        if (Node.isComputedPropertyName(nameNode)) {
          // { ...base, [k]: v } → base.set(k, v); { [k]: v } → {}.set(k, v)
          const base: RawExpr = acc ?? { kind: "record", spread: null, fields: [] };
          acc = { kind: "call", fn: { kind: "field", obj: base, field: "set" }, args: [extractExpr(nameNode.getExpression()), extractExpr(init)] };
        } else {
          // String-literal keys (e.g. `"bun run": 3`) — use the unquoted literal
          // value; otherwise `prop.getName()` may include surrounding quotes.
          const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : prop.getName();
          update(name, extractExpr(init));
        }
      }
    }
    return acc ?? { kind: "record", spread: null, fields: [] };
  }

  // Ternary: cond ? then : else
  if (Node.isConditionalExpression(node)) {
    return { kind: "conditional", cond: extractExpr(node.getCondition()), then: extractExpr(node.getWhenTrue()), else: extractExpr(node.getWhenFalse()) };
  }

  // Non-null assertion: expr!
  if (Node.isNonNullExpression(node)) {
    return { kind: "nonNull", expr: extractExpr(node.getExpression()) };
  }

  // new Map<K,V>() / new Set<T>() — with or without initializer
  if (Node.isNewExpression(node)) {
    const name = node.getExpression().getText();
    if (name === "Map" || name === "Set") {
      const typeArgs = node.getTypeArguments();
      // Use explicit type args if present, otherwise infer from TS type system
      const tsType = typeArgs && typeArgs.length > 0
        ? `${name}<${typeArgs.map(t => t.getText()).join(", ")}>`
        : _eraseGenerics(typeToString(node.getType()));
      const args = node.getArguments();
      // new Map(source) — clone existing map or build from entries
      if (name === "Map" && args && args.length === 1) {
        const argType = (args[0] as Expression).getType();
        const argSymbol = argType.getSymbol()?.getName() ?? argType.getAliasSymbol()?.getName();
        const argTypeText = _eraseGenerics(typeToString(argType));
        if (argSymbol === "Map" || argTypeText.startsWith("Record<")) {
          // new Map(existingMap) or new Map(record) — identity (Dafny maps are value types)
          return extractExpr(args[0] as Expression);
        }
        // new Map(entries) — map-from-array constructor
        return { kind: "call", fn: { kind: "var", name: "__mapFromArray" }, args: [extractExpr(args[0] as Expression)] };
      }
      // new Set([a, b, c]) — set with initial elements
      if (name === "Set" && args && args.length === 1) {
        const arg = args[0] as Expression;
        if (Node.isArrayLiteralExpression(arg)) {
          return { kind: "emptyCollection", collectionType: "Set", tsType, initElems: arg.getElements().map(e => extractExpr(e as Expression)) };
        }
        const argSymbol = arg.getType().getSymbol()?.getName() ?? arg.getType().getAliasSymbol()?.getName();
        // new Set(existingSet) — identity (sets are value types)
        if (argSymbol === "Set") return extractExpr(arg);
        // new Set(arr) — build a deduplicated set from the array's elements
        return { kind: "call", fn: { kind: "var", name: "__setFromArray" }, args: [extractExpr(arg)] };
      }
      return { kind: "emptyCollection", collectionType: name as "Map" | "Set", tsType };
    }
  }

  // As-expression: expr as T — strip the type assertion
  if (Node.isAsExpression(node)) {
    return extractExpr(node.getExpression());
  }

  // delete obj[key] → map delete expression
  if (Node.isDeleteExpression(node)) {
    const expr = node.getExpression();
    if (Node.isElementAccessExpression(expr)) {
      return {
        kind: "call",
        fn: { kind: "field", obj: extractExpr(expr.getExpression()), field: "delete" },
        args: [extractExpr(expr.getArgumentExpression()!)],
      };
    }
  }

  // null → undefined (both map to None in backends)
  if (Node.isNullLiteral(node)) {
    return { kind: "var", name: "undefined" };
  }

  // `typeof X` — only meaningful in a `typeof X === "string"` discriminator over
  // a synth `U | T[]` union (see narrow's parseTypeofStringCheck); any other use
  // survives to emit and errors there.
  if (Node.isTypeOfExpression(node)) {
    return { kind: "unop", op: "typeof", expr: extractExpr(node.getExpression()) };
  }

  throw new Error(`Unsupported expression: ${node.getText()}`);
}

// ── Annotation parsing ───────────────────────────────────────

const PREFIX = "//@ ";
const KEYWORDS = ["requires", "ensures", "contract", "invariant", "decreases", "done_with", "type", "reveal"] as const;
export type AnnotKind = (typeof KEYWORDS)[number];
interface Annotation { kind: AnnotKind; expr: string }

function parseAnnotations(node: Node): Annotation[] {
  const result: Annotation[] = [];
  for (const range of node.getLeadingCommentRanges()) {
    const text = range.getText().trim();
    if (!text.startsWith(PREFIX)) continue;
    const content = text.slice(PREFIX.length);
    const sp = content.indexOf(" ");
    if (sp === -1) continue;
    const kw = content.slice(0, sp);
    if (!(KEYWORDS as readonly string[]).includes(kw)) continue;
    result.push({ kind: kw as AnnotKind, expr: content.slice(sp + 1).trim() });
  }
  return result;
}

function collectAnnotations(node: Node, body?: Node[]): Annotation[] {
  const own = parseAnnotations(node);
  if (body && body.length > 0) return [...own, ...parseAnnotations(body[0])];
  return own;
}

// A loop's `//@ invariant`/`decreases`/`done_with` annotations live as leading
// comments of its first body statement — never on the loop node itself. (The
// loop node's own leading comments belong to whatever precedes it; when the
// loop is the first statement of an *enclosing* loop, those comments are the
// enclosing loop's invariants, which must not leak in.) So collect from the
// body alone, unlike `collectAnnotations`, which also reads the node (needed for
// functions, whose specs may precede the declaration).
function collectLoopAnnotations(body: Node[]): Annotation[] {
  return body.length > 0 ? parseAnnotations(body[0]) : [];
}

/** All `//@ ` annotations for a function-like node, regardless of whether its
 *  body is a block (annotations on the first statement) or an expression-body
 *  arrow (annotations only on the declaration). Used both for in-file function
 *  extraction and for pulling specs off cross-file externs. */
function collectFunctionAnnotations(fn: Node): Annotation[] {
  const body = (fn as any).getBody?.();
  if (body && Node.isBlock(body)) {
    return collectAnnotations(fn, body.getStatements() as Node[]);
  }
  return collectAnnotations(fn);
}

/** Check for a bare function annotation such as `//@ pure` or `//@ impure`.
 *  Function annotations may precede the declaration or its first statement. */
function hasBareFunctionAnnotation(node: Node, keyword: string, body?: Node[]): boolean {
  if (!body) {
    const fnBody = (node as any).getBody?.();
    if (fnBody && Node.isBlock(fnBody)) body = fnBody.getStatements() as Node[];
  }
  const nodes = body && body.length > 0 ? [node, body[0]] : [node];
  for (const n of nodes) {
    for (const range of n.getLeadingCommentRanges()) {
      if (range.getText().trim() === `//@ ${keyword}`) return true;
    }
  }
  return false;
}

/** Check for bare `//@ pure` annotation (no expression). */
function hasPureAnnotation(node: Node, body?: Node[]): boolean {
  return hasBareFunctionAnnotation(node, "pure", body);
}

function enclosingVariableStatement(node: Node): Node | undefined {
  let current = node.getParent();
  while (current && !Node.isSourceFile(current)) {
    if (Node.isVariableStatement(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

/** `pure`/`impure` may be attached to a function, its first statement, or the
 *  variable statement that owns a const arrow. */
function hasExternModeAnnotation(node: Node, keyword: "pure" | "impure", parentStmt?: Node): boolean {
  if (hasBareFunctionAnnotation(node, keyword)) return true;
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && Node.isArrowFunction(init) && hasBareFunctionAnnotation(init, keyword)) return true;
  }
  const statement = parentStmt ?? enclosingVariableStatement(node);
  return !!statement && statement.getLeadingCommentRanges()
    .some(r => r.getText().trim() === `//@ ${keyword}`);
}

/** The first lone surrogate code unit in `value`, or -1. */
function findLoneSurrogate(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { i++; continue; }
      return unit;
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) return unit;
  }
  return -1;
}

/** A source string literal, admitted only if the selected string profile can
 *  represent it (DESIGN_STRINGS.md §3). Under `unicode-scalar` a lone surrogate
 *  has no Dafny value — and Node's UTF-8 writer would silently replace it on
 *  the way out — so it is refused here with the source line instead. */
function stringLiteral(value: string, node: Node): RawExpr {
  if (_extractOptions["string-semantics"] === "unicode-scalar") {
    const lone = findLoneSurrogate(value);
    if (lone >= 0) {
      const file = node.getSourceFile();
      const { line } = file.getLineAndColumnAtPos(node.getStart());
      throw new Error(
        `${file.getFilePath()}:${line}: string literal contains an unpaired surrogate ` +
        `U+${lone.toString(16).toUpperCase()}, which "string-semantics": "unicode-scalar" cannot ` +
        `represent; select string-semantics=javascript-utf16 and dafny-library=local in lemmascript.json or //@ option directives`,
      );
    }
  }
  return { kind: "str", value };
}

function externIsImpure(node: Node, name: string, parentStmt?: Node): boolean {
  const pure = hasExternModeAnnotation(node, "pure", parentStmt);
  const impure = hasExternModeAnnotation(node, "impure", parentStmt);
  if (pure && impure) throw new Error(`${name}: extern cannot be both //@ pure and //@ impure`);
  if (impure) return true;
  if (pure) return false;
  return _extractOptions["extern-default"] === "impure";
}

// ── Type declaration extraction ──────────────────────────────

function extractTypeDecl(decl: TypeAliasDeclaration, extraDecls?: TypeDeclInfo[]): TypeDeclInfo | null {
  const name = decl.getName();
  const type = decl.getType();
  const typeParams = decl.getTypeParameters().map(tp => tp.getName());
  const tpField = typeParams.length > 0 ? typeParams : undefined;

  // Leading `//@ type <ty>` overrides extraction — the declared TS type is
  // replaced by the annotated backend type. Used to coerce literal unions
  // (`5 | 15 | 30` → `nat`) and other types LS can't model precisely.
  const override = parseAnnotations(decl).find(a => a.kind === "type");
  if (override) return { name, typeParams: tpField, kind: "alias", aliasOf: override.expr };

  if (type.isUnion()) {
    const members = type.getUnionTypes();
    if (members.every(m => m.isStringLiteral())) {
      return { name, typeParams: tpField, kind: "string-union", values: members.map(m => m.getLiteralValue() as string) };
    }
    if (members.every(m => m.isObject())) {
      const discriminant = findDiscriminant(members);
      if (discriminant) {
        const variants: VariantInfo[] = members.map(m => {
          const tagProp = m.getProperty(discriminant);
          const tagType = tagProp?.getTypeAtLocation(decl);
          const tag = tagType?.isStringLiteral() ? String(tagType.getLiteralValue())
            : tagType?.getText() ?? "unknown";
          const fields: { name: string; tsType: string }[] = [];
          for (const prop of m.getProperties()) {
            if (prop.getName() === discriminant) continue;
            let tsType = typeToString(prop.getTypeAtLocation(decl));
            const propDecl = prop.getDeclarations()[0];
            tsType = declaredTypeTextIfBetter(propDecl, tsType);
            if (propDecl && (propDecl as any).hasQuestionToken?.()) {
              // Normalize checker output that puts `undefined` first, then
              // ensure exactly one trailing `| undefined`.
              if (tsType.startsWith("undefined | ")) tsType = `${tsType.slice("undefined | ".length)} | undefined`;
              else if (!tsType.includes(" | undefined")) tsType = `${tsType} | undefined`;
            }
            fields.push({ name: prop.getName(), tsType });
          }
          return { name: tag, fields };
        });
        return { name, typeParams: tpField, kind: "discriminated-union", discriminant, variants };
      }
    }
  }

  // Single-variant discriminated union: type X = | { kind: 'Foo', ... }
  // TypeScript collapses single-member unions to their member type,
  // so type.isUnion() returns false. Detect by checking the source text
  // for union syntax '|' AND a string-literal discriminant field.
  if (type.isObject() && !type.isIntersection()) {
    const srcText = decl.getTypeNode()?.getText() ?? "";
    if (srcText.includes("|")) {
      const disc = findDiscriminant([type]);
      if (disc) {
        const tagProp = type.getProperty(disc);
        const tagType = tagProp?.getTypeAtLocation(decl);
        const tag = tagType?.isStringLiteral() ? String(tagType.getLiteralValue()) : null;
        if (tag) {
          const fields: { name: string; tsType: string }[] = [];
          for (const prop of type.getProperties()) {
            if (prop.getName() === disc) continue;
            fields.push({ name: prop.getName(), tsType: typeToString(prop.getTypeAtLocation(decl)) });
          }
          return { name, typeParams: tpField, kind: "discriminated-union", discriminant: disc, variants: [{ name: tag, fields }] };
        }
      }
    }
  }

  // Function-type alias: `type Comparator = (a: T, b: T) => boolean` —
  // ts-morph reports these as object-typed with a call signature and no
  // user-visible properties. Emit as a Dafny `type X = (...) -> R` alias.
  if (type.isObject()) {
    const sig = type.getCallSignatures()[0];
    const hasProps = type.getProperties().length > 0;
    if (sig && !hasProps) {
      // Synthesize fresh param names — the ts-morph parser used downstream
      // needs `name: T` syntax; bare `T` is read as a param name with `any`.
      const params = sig.getParameters().map((p, i) => `_p${i}: ${typeToString(p.getTypeAtLocation(decl))}`);
      const ret = typeToString(sig.getReturnType());
      return { name, kind: "alias", aliasOf: `(${params.join(", ")}) => ${ret}` };
    }
  }
  // Array-type alias: `type Board = number[]` → alias to the seq type, not a
  // record. Arrays report as object types, so this must precede the record
  // branch, which would otherwise enumerate the Array prototype as fields.
  // Build the element type directly: typeToString(type) would return the
  // alias's own name (via getAliasSymbol), yielding a self-referential alias.
  if (type.isArray()) {
    const elem = type.getArrayElementTypeOrThrow();
    return { name, typeParams: tpField, kind: "alias", aliasOf: `${typeToString(elem)}[]` };
  }
  if (type.isObject() || type.isIntersection()) {
    const record = extractRecord(name, type, decl, undefined, extraDecls);
    return record && tpField ? { ...record, typeParams: tpField } : record;
  }
  // Primitive type alias: type TaskId = number → alias
  const tsType = typeToString(type);
  if (tsType !== name) return { name, kind: "alias", aliasOf: tsType };
  return null;
}

function extractInterface(decl: InterfaceDeclaration, extraDecls?: TypeDeclInfo[]): TypeDeclInfo | null {
  // Collect field type overrides from trailing //@ type annotations
  const overrides = new Map<string, string>();
  for (const member of decl.getMembers()) {
    if (Node.isPropertySignature(member)) {
      const text = member.getTrailingCommentRanges().map(r => r.getText()).join(" ");
      const match = text.match(/\/\/@ type (\w+)/);
      if (match) overrides.set(member.getName(), match[1]);
    }
  }
  const record = extractRecord(decl.getName(), decl.getType(), decl, overrides, extraDecls);
  // A generic record keeps its type parameters, as generic unions do.
  const typeParams = decl.getTypeParameters().map(tp => tp.getName());
  return record && typeParams.length > 0 ? { ...record, typeParams } : record;
}

function extractRecord(name: string, type: Type, locationNode: Node, overrides?: Map<string, string>, extraDecls?: TypeDeclInfo[]): TypeDeclInfo | null {
  const props = type.getProperties();
  if (props.length === 0) return null;
  const fields: { name: string; tsType: string }[] = [];
  for (const prop of props) {
    const override = overrides?.get(prop.getName());
    if (override) { fields.push({ name: prop.getName(), tsType: override }); continue; }

    const propType = prop.getTypeAtLocation(locationNode);
    let tsType = typeToString(propType);
    const propDecl = prop.getDeclarations()[0];
    tsType = declaredTypeTextIfBetter(propDecl, tsType);
    // Optional property: `foo?: T` reports as `T` (ts-morph strips the
    // `| undefined` from a question-token type). Add it back so the field
    // resolves to `Optional<T>`.
    if (propDecl && (propDecl as any).hasQuestionToken?.()) {
      // Normalize checker output that puts `undefined` first, then ensure
      // exactly one trailing `| undefined`.
      if (tsType.startsWith("undefined | ")) tsType = `${tsType.slice("undefined | ".length)} | undefined`;
      else if (!tsType.includes(" | undefined")) tsType = `${tsType} | undefined`;
    }

    // Inline anonymous object types: ts-morph names them __type.
    // Generate a synthetic named record and reference it by name instead.
    if (extraDecls && tsType.includes("__type")) {
      let innerType = propType;
      let isOptional = false;
      if (propType.isUnion()) {
        const uTypes = propType.getUnionTypes();
        const nonUndef = uTypes.filter(t => !t.isUndefined());
        if (uTypes.some(t => t.isUndefined()) && nonUndef.length === 1) {
          innerType = nonUndef[0];
          isOptional = true;
        }
      }
      if (innerType.isObject() && !innerType.isArray()) {
        const fName = prop.getName();
        const synName = name + fName.charAt(0).toUpperCase() + fName.slice(1);
        const extracted = extractRecord(synName, innerType, locationNode, undefined, extraDecls);
        if (extracted) {
          extraDecls.push(extracted);
          tsType = isOptional ? `${synName} | undefined` : synName;
        }
      }
    }

    fields.push({ name: prop.getName(), tsType });
  }
  return { name, kind: "record", fields };
}

function findDiscriminant(members: Type[]): string | null {
  if (members.length === 0) return null;
  const firstProps = members[0].getProperties();
  for (const prop of firstProps) {
    const name = prop.getName();
    const allHave = members.every(m => {
      const p = m.getProperty(name);
      if (!p) return false;
      const t = p.getDeclarations()[0] ? p.getTypeAtLocation(p.getDeclarations()[0]) : null;
      return (t?.isStringLiteral() || t?.isBooleanLiteral()) ?? false;
    });
    if (allHave) return name;
  }
  return null;
}

/** Recover a field's *declared* type text when the semantic printer degraded
 *  to ts-morph's anonymous `__type` — a self-referential alias reached
 *  through a `| null` union expands structurally and loses its name. The
 *  syntactic node text preserves the alias spelling (`TExpr | null`). Only
 *  plain reference text is used: inline object literals (containing `{`)
 *  keep the `__type` marker so record synthesis can handle them. */
function declaredTypeTextIfBetter(propDecl: Node | undefined, tsType: string): string {
  if (!propDecl) return tsType;
  const tn = (propDecl as { getTypeNode?: () => Node | undefined }).getTypeNode?.();
  if (!tn) return tsType;
  const text = tn.getText();
  // The checker erases `type real = number` to `number`, which would model the field as an integer.
  if (text === "real" && /^(?:undefined \| )?number(?: \| undefined)?$/.test(tsType)) return text;
  if (!tsType.includes("__type")) return tsType;
  if (text.includes("__type") || text.includes("{")) return tsType;
  return text;
}

function typeToString(type: Type): string {
  if (type.isUndefined()) return "undefined";
  if (type.isNumber() || type.isNumberLiteral()) return "number";
  if (type.isBigInt() || type.isBigIntLiteral()) return "bigint";
  if (type.isString() || type.isStringLiteral()) return "string";
  // TS expands `boolean` to the literal union `false | true`; normalize the
  // literals back so the union dedupes to a single `boolean` rather than being
  // mistaken for an unmodelable multi-member union.
  if (type.isBoolean() || type.isBooleanLiteral()) return "boolean";
  // Named type alias (e.g. Priority = "low" | "medium" | "high") — use the alias name
  if (type.getAliasSymbol()) {
    const name = type.getAliasSymbol()!.getName();
    const args = type.getAliasTypeArguments();
    if (args.length > 0) return `${name}<${args.map(t => typeToString(t)).join(", ")}>`;
    return name;
  }
  if (type.isUnion()) {
    const unionTypes = type.getUnionTypes();
    // `T[] | U` synthesis: exactly two members, one array, the other not
    // array/undefined/null. Detected via ts-morph type predicates (no string
    // parsing). Registers a discriminated-union TypeDeclInfo with variants
    // ArrayBranch(arr: T[]) and NonArrayBranch(val: U); returns the synthetic
    // name so all downstream tsType slots agree. `T[] | undefined` and
    // `T[] | T[]` fall through to the existing path unchanged.
    if (_synthArrayUnions !== null && unionTypes.length === 2) {
      const [m0, m1] = unionTypes;
      const arrayMember = m0.isArray() ? m0 : (m1.isArray() ? m1 : null);
      const otherMember = arrayMember === m0 ? m1 : m0;
      if (arrayMember && otherMember && !otherMember.isArray()
          && !otherMember.isUndefined() && !otherMember.isNull()) {
        const elemName = typeToString(arrayMember.getArrayElementTypeOrThrow());
        const otherName = typeToString(otherMember);
        const synthName = _synthName(elemName, otherName);
        if (!_synthArrayUnions.some(d => d.name === synthName)) {
          _synthArrayUnions.push({
            name: synthName,
            kind: "discriminated-union",
            discriminant: "__isArray__",
            variants: [
              { name: "ArrayBranch", fields: [{ name: "arr", tsType: `${elemName}[]` }] },
              { name: "NonArrayBranch", fields: [{ name: "val", tsType: otherName }] },
            ],
          });
        }
        return synthName;
      }
    }
    const parts = [...new Set(unionTypes.map(typeToString))];
    // `undefined`/`null` are optional markers; a single real member with them
    // is an Option, left as `X | undefined` for the optional lowering.
    const real = parts.filter(p => p !== "undefined" && p !== "null");
    if (real.length <= 1) return parts.join(" | ");
    // A genuine multi-member union with no tagged-union shape LS can model →
    // a single opaque type. (See _synthOpaque.) Preserve an outer optional.
    const opaque = _synthOpaque(real);
    return real.length === parts.length ? opaque : `${opaque} | undefined`;
  }
  if (type.isTuple()) {
    return `[${type.getTupleElements().map(t => typeToString(t)).join(", ")}]`;
  }
  if (type.isArray()) {
    const elem = type.getArrayElementTypeOrThrow();
    return `${typeToString(elem)}[]`;
  }
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol) {
    const name = symbol.getName();
    // Recover collapsed single-variant union alias via property fingerprint
    if (name === "__type" && _collapsedUnionMap.size > 0) {
      const props = type.getProperties().map(p => p.getName()).sort().join(",");
      const alias = _collapsedUnionMap.get(props);
      if (alias) return alias;
    }
    const typeArgs = type.getTypeArguments();
    if (typeArgs.length > 0) {
      return `${name}<${typeArgs.map(t => typeToString(t)).join(", ")}>`;
    }
    return name;
  }
  return type.getText();
}

const COMPOUND_OPS: Record<string, string> = {
  "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%",
  "<<=": "<<", ">>=": ">>", "|=": "|", "&=": "&", "^=": "^", "**=": "**",
};

/** Desugar a statement-position side-effecting expression — `x = e`, `x += e`,
 *  `i++`, `arr[i] = v`, etc. — into a `RawAssign`. Returns null when no shape
 *  match (caller emits a plain `{kind: "expr"}` or errors). Called by both
 *  `ExpressionStatement` extraction (wrapped) and the C-style for-loop
 *  incrementor (bare Expression — same shape, no `;` wrapper). */
function desugarStmtExpr(expr: Expression, line: number): RawStmt | null {
  if (Node.isBinaryExpression(expr)) {
    const opText = expr.getOperatorToken().getText();
    const left = expr.getLeft();
    if (opText === "=" && Node.isElementAccessExpression(left)) {
      const obj = extractExpr(left.getExpression());
      const idx = extractExpr(left.getArgumentExpression()!);
      const val = extractExpr(expr.getRight());
      const target = left.getExpression().getText();
      const withCall: RawExpr = { kind: "call", fn: { kind: "field", obj, field: "with" }, args: [idx, val] };
      return { kind: "assign", target, value: withCall, line };
    }
    if (opText === "=") {
      return { kind: "assign", target: left.getText(), value: extractExpr(expr.getRight()), line };
    }
    const compound = COMPOUND_OPS[opText];
    if (compound) {
      const target = left.getText();
      return {
        kind: "assign", target,
        value: { kind: "binop", op: compound, left: { kind: "var", name: target }, right: extractExpr(expr.getRight()) },
        line,
      };
    }
  }
  if ((Node.isPostfixUnaryExpression(expr) || Node.isPrefixUnaryExpression(expr)) &&
      (expr.getOperatorToken() === SyntaxKind.PlusPlusToken || expr.getOperatorToken() === SyntaxKind.MinusMinusToken)) {
    const target = expr.getOperand().getText();
    const op = expr.getOperatorToken() === SyntaxKind.PlusPlusToken ? "+" : "-";
    return {
      kind: "assign", target,
      value: { kind: "binop", op, left: { kind: "var", name: target }, right: { kind: "num", value: 1 } },
      line,
    };
  }
  return null;
}

// A C-style `for (let i …)` counter is hoisted out of its loop scope into the
// enclosing block (the desugar runs `init; while (cond) { body; update }`). If
// another binding of that name shares the hoisted scope — a sibling `let i`, or
// an enclosing for-loop whose own `i` stays live where the inner counter and the
// outer update sit — the two collapse to one Dafny `var i` ("Duplicate
// local-variable name", or a silently-misbound update). When that happens we
// rename this counter to a fresh `<name>_N` in the loop's own desugared pieces.
//
// `forCounterRename` is a read-only scope check (no AST mutation): it returns the
// fresh name when this counter would collide, else null — so a non-conflicting
// loop keeps its name and output is byte-identical. The rename itself is applied
// to the extracted Raw IR by `renameRawStmts` / `renameRawExpr` (code) and
// `renameSpec` (the `//@` strings, still unparsed at this phase).
function forCounterRename(decl: VariableDeclaration, forStmt: Node): string | null {
  const name = decl.getName();
  const fnLike = forStmt.getFirstAncestor(a =>
    Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
    Node.isFunctionExpression(a) || Node.isMethodDeclaration(a));
  const scopeRoot: Node = fnLike ?? forStmt.getSourceFile();

  const isScope = (a: Node) => Node.isBlock(a) || Node.isSourceFile(a) ||
    Node.isForStatement(a) || Node.isForOfStatement(a) || Node.isForInStatement(a);
  // A counting-`for` counter is hoisted out of its `for`, so its real scope is
  // the nearest enclosing block, not the `for` itself.
  const hoistScope = (d: VariableDeclaration): Node | undefined => {
    const owner = d.getParent()?.getParent();
    return owner && Node.isForStatement(owner) && owner.getInitializer() === d.getParent()
      ? d.getFirstAncestor(a => Node.isBlock(a) || Node.isSourceFile(a))
      : undefined;
  };
  // Scopes that enclose this loop — its counter, once hoisted, lives in one of
  // these, so a same-named binding scoped here would collide.
  const enclosing = new Set<Node>(forStmt.getAncestors());

  const paramClash = (fnLike as any)?.getParameters?.().some((p: any) => p.getName() === name) ?? false;
  const declClash = scopeRoot.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some(d => {
    if (d === decl || d.getName() !== name) return false;
    // Two sibling for-counters hoisting into the same block: rename only the
    // later loop, so the first keeps its name. Any other clash (e.g. a `let`) yields.
    const counterScope = hoistScope(d);
    if (counterScope) return enclosing.has(counterScope) && d.getStart() < decl.getStart();
    const scope = d.getFirstAncestor(isScope);
    return !!scope && enclosing.has(scope);
  });
  if (!paramClash && !declClash) return null;

  const used = new Set(scopeRoot.getDescendantsOfKind(SyntaxKind.Identifier).map(i => i.getText()));
  let n = 2;
  while (used.has(`${name}_${n}`) || _reservedForCounterNames.has(`${name}_${n}`)) n++;
  const fresh = `${name}_${n}`;
  _reservedForCounterNames.add(fresh);
  return fresh;
}

/** Whole-word rename of an identifier inside an unparsed `//@` spec string. */
function renameSpec(s: string, from: string, to: string): string {
  return s.replace(new RegExp(`\\b${from}\\b`, "g"), to);
}

/** Rename free references to `from` → `to` in a Raw expression, stopping under a
 *  lambda / quantifier that re-binds the name (it shadows). */
function renameRawExpr(e: RawExpr, from: string, to: string): RawExpr {
  const r = (x: RawExpr) => renameRawExpr(x, from, to);
  switch (e.kind) {
    case "var": return e.name === from ? { kind: "var", name: to } : e;
    case "num": case "bigint": case "str": case "bool": case "result": case "havoc": case "emptyCollection": return e;
    case "binop": return { ...e, left: r(e.left), right: r(e.right) };
    case "unop": return { ...e, expr: r(e.expr) };
    case "call": return { ...e, fn: r(e.fn), args: e.args.map(r) };
    case "index": return { ...e, obj: r(e.obj), idx: r(e.idx) };
    case "field": return { ...e, obj: r(e.obj) };
    case "record": return { ...e, spread: e.spread ? r(e.spread) : null, fields: e.fields.map(f => ({ ...f, value: r(f.value) })) };
    case "recordMerge": return { ...e, base: r(e.base), override: r(e.override) };
    case "arrayLiteral": return { ...e, elems: e.elems.map(r) };
    case "conditional": return { ...e, cond: r(e.cond), then: r(e.then), else: r(e.else) };
    case "nullish": return { ...e, left: r(e.left), right: r(e.right) };
    case "nonNull": return { ...e, expr: r(e.expr) };
    case "optChain": return { ...e, obj: r(e.obj), chain: e.chain.map(c =>
      c.kind === "call" ? { ...c, args: c.args.map(r) } : c.kind === "index" ? { ...c, idx: r(c.idx) } : c) };
    case "lambda": return e.params.some(p => p.name === from) ? e
      : { ...e, body: Array.isArray(e.body) ? renameRawStmts(e.body, from, to) : r(e.body) };
    case "forall": case "exists": return e.var === from ? e : { ...e, body: r(e.body) };
  }
}

/** Rename references to `from` → `to` across a Raw statement (code refs via
 *  `renameRawExpr`, `//@` strings via `renameSpec`). Statement lists stop
 *  renaming once a `let from` re-declares the name (it shadows). */
function renameRawStmt(s: RawStmt, from: string, to: string): RawStmt {
  const r = (x: RawExpr) => renameRawExpr(x, from, to);
  const sp = (x: string) => renameSpec(x, from, to);
  switch (s.kind) {
    case "let": return { ...s, init: r(s.init) };  // name kept: a shadowing binding is a different variable
    case "assign": return { ...s, target: s.target === from ? to : s.target, value: r(s.value) };
    case "return": return { ...s, value: r(s.value) };
    case "expr": return { ...s, expr: r(s.expr) };
    case "if": return { ...s, cond: r(s.cond), then: renameRawStmts(s.then, from, to), else: renameRawStmts(s.else, from, to) };
    case "while": return { ...s, cond: r(s.cond), invariants: s.invariants.map(sp),
      decreases: s.decreases ? sp(s.decreases) : null, doneWith: s.doneWith ? sp(s.doneWith) : null,
      body: renameRawStmts(s.body, from, to) };
    case "forof": return e_forof(s);
    case "switch": return { ...s, expr: r(s.expr), cases: s.cases.map(c => ({ ...c, body: renameRawStmts(c.body, from, to) })),
      defaultBody: renameRawStmts(s.defaultBody, from, to) };
    case "ghostLet": return { ...s, init: sp(s.init) };
    case "ghostAssign": return { ...s, target: s.target === from ? to : s.target, value: sp(s.value) };
    case "assert": return { ...s, expr: sp(s.expr) };
    case "break": case "continue": case "throw": return s;
  }
  function e_forof(f: RawStmt & { kind: "forof" }): RawStmt {
    // for-of names bind in the body; if one shadows `from`, leave the body alone.
    const body = f.names.includes(from) ? f.body : renameRawStmts(f.body, from, to);
    return { ...f, iterable: r(f.iterable), invariants: f.invariants.map(sp),
      doneWith: f.doneWith ? sp(f.doneWith) : null, body };
  }
}

/** Rename `from` → `to` through a statement list, stopping after a `let from`
 *  shadows it (subsequent references are a different variable). */
function renameRawStmts(stmts: RawStmt[], from: string, to: string): RawStmt[] {
  const out: RawStmt[] = [];
  let active = true;
  for (const s of stmts) {
    if (!active) { out.push(s); continue; }
    out.push(renameRawStmt(s, from, to));
    if (s.kind === "let" && s.name === from) active = false;
  }
  return out;
}

// ── Statement extraction ─────────────────────────────────────

/** Parse ghost and assert annotations from comment ranges. */
function parseSpecComments(ranges: ReturnType<Node["getLeadingCommentRanges"]>, line: number): (RawGhostLet | RawGhostAssign | import("./rawir.js").RawAssert)[] {
  const result: (RawGhostLet | RawGhostAssign | import("./rawir.js").RawAssert)[] = [];
  for (const range of ranges) {
    const text = range.getText().trim();
    if (!text.startsWith(PREFIX)) continue;
    const content = text.slice(PREFIX.length);
    // assert expr
    if (content.startsWith("assert ")) {
      result.push({ kind: "assert", expr: content.slice(7).trim(), line });
      continue;
    }
    // assume expr — trusted form of assert; emitted as `assume P;` in Dafny.
    if (content.startsWith("assume ")) {
      result.push({ kind: "assert", expr: content.slice(7).trim(), line, assumed: true });
      continue;
    }
    if (!content.startsWith("ghost ")) continue;
    const ghostBody = content.slice(6).trim();
    // ghost let varName: type = expr  OR  ghost let varName = expr
    // Type segment accepts compound forms like `number[]`, `Map<K,V>`, etc.
    const letMatch = ghostBody.match(/^let\s+(\w+)(?:\s*:\s*([^=]+?))?\s*=\s*(.+)$/);
    if (letMatch) {
      result.push({ kind: "ghostLet", name: letMatch[1], tsType: letMatch[2]?.trim() ?? null, init: letMatch[3].trim(), line });
      continue;
    }
    // ghost varName = expr
    const assignMatch = ghostBody.match(/^(\w+)\s*=\s*(.+)$/);
    if (assignMatch) {
      result.push({ kind: "ghostAssign", target: assignMatch[1], value: assignMatch[2].trim(), line });
    }
  }
  return result;
}

/** Splice `update` before each `continue` in the same loop scope. Recurses
 *  into `if`/`switch` (same scope) but not nested `while`/`forof` (they own
 *  their own continue). Used by the C-style `for` desugar so a `continue`
 *  doesn't skip the loop update. The `update` node is shared by reference —
 *  the IR is transformed functionally downstream (no in-place mutation), so
 *  aliasing it across the body is safe. */
function insertUpdateBeforeContinue(stmts: RawStmt[], update: RawStmt): RawStmt[] {
  const out: RawStmt[] = [];
  for (const s of stmts) {
    if (s.kind === "continue") {
      out.push(update, s);
    } else if (s.kind === "if") {
      out.push({ ...s, then: insertUpdateBeforeContinue(s.then, update), else: insertUpdateBeforeContinue(s.else, update) });
    } else if (s.kind === "switch") {
      out.push({
        ...s,
        cases: s.cases.map(c => ({ ...c, body: insertUpdateBeforeContinue(c.body, update) })),
        defaultBody: insertUpdateBeforeContinue(s.defaultBody, update),
      });
    } else {
      out.push(s);
    }
  }
  return out;
}

function extractStmts(stmts: Node[]): RawStmt[] {
  const result: RawStmt[] = [];
  for (const s of stmts) {
    const line = s.getStartLineNumber();

    // Ghost annotations from leading comments → inject before this statement
    const leadingComments = s.getLeadingCommentRanges();
    result.push(...parseSpecComments(leadingComments, line));

    // //@ skip — omit this statement from the verification model
    if (leadingComments.some(r => r.getText().trim() === "//@ skip")) {
      continue;
    }

    if (Node.isVariableStatement(s)) {
      const havoc = havocDirective(s);
      const havocType = havoc?.type ?? null;   // //@ havoc : Type
      const havocKey = havoc?.key ?? null;     // //@ havoc key
      const isHavoc = !!havoc;
      for (const d of s.getDeclarations()) {
        // Havoc on destructuring: emit each named binding as a separate havoced variable
        const nameNode = d.getNameNode();
        if (isHavoc && !havocKey && Node.isObjectBindingPattern(nameNode)) {
          const rhsType = d.getType();
          const havocTypes = havocType?.split(",").map(t => t.trim()) ?? [];
          const elements = nameNode.getElements();
          for (let ei = 0; ei < elements.length; ei++) {
            const el = elements[ei];
            const name = el.getName();
            const propType = rhsType.getProperty(name)?.getTypeAtLocation(d);
            const tsType = havocTypes[ei] ?? (propType ? _eraseGenerics(typeToString(propType)) : "unknown");
            result.push({
              kind: "let", name, mutable: s.getDeclarationKind() === "let",
              tsType, init: { kind: "havoc", tsType }, line,
            });
          }
          continue;
        }
        // Array destructuring: const [a, , c, ...rest] = arr → individual lets,
        // each picking from `arr` by position. Rest (if present) must be last
        // and emits as `arr.slice(N)`. Omitted slots (`,,`) are skipped. Nested
        // binding patterns throw — extend the helper here when a case study
        // hits them.
        if (!isHavoc && Node.isArrayBindingPattern(nameNode)) {
          const elements = nameNode.getElements();
          const initializer = d.getInitializer();
          if (initializer) {
            let initExpr: RawExpr = extractExpr(initializer);
            let initVar: RawExpr = initExpr;
            if (initExpr.kind !== "var") {
              const tempName = freshName(`_destr${_destrCounter++}`);
              const initTs = _eraseGenerics(typeToString(initializer.getType()));
              result.push({ kind: "let", name: tempName, mutable: false, tsType: initTs, init: initExpr, line });
              initVar = { kind: "var", name: tempName };
            }
            for (let i = 0; i < elements.length; i++) {
              const el = elements[i];
              if (Node.isOmittedExpression(el)) continue;
              if (!Node.isBindingElement(el)) continue;
              const inner = el.getNameNode();
              if (!Node.isIdentifier(inner)) {
                throw new Error(`nested binding pattern in array destructuring not yet supported: ${el.getText()}`);
              }
              const name = inner.getText();
              const isRest = !!el.getDotDotDotToken();
              const elTs = _eraseGenerics(typeToString(el.getType()));
              const init: RawExpr = isRest
                ? { kind: "call",
                    fn: { kind: "field", obj: initVar, field: "slice" },
                    args: [{ kind: "num", value: i }] }
                : { kind: "index", obj: initVar, idx: { kind: "num", value: i } };
              result.push({ kind: "let", name, mutable: s.getDeclarationKind() === "let", tsType: elTs, init, line });
            }
            continue;
          }
        }
        // Plain object destructuring: const { a, b, c } = obj → field access lets.
        // Skipped if any element has a computed property (handled by the rest+
        // computed branch below) or a rest element (also handled below).
        if (!isHavoc && Node.isObjectBindingPattern(nameNode)) {
          const elements = nameNode.getElements();
          const hasRest = elements.some(el => el.getDotDotDotToken());
          const hasComputed = elements.some(el => {
            const pn = el.getPropertyNameNode();
            return pn && Node.isComputedPropertyName(pn);
          });
          if (!hasRest && !hasComputed) {
            const initializer = d.getInitializer();
            if (initializer) {
              let initExpr: RawExpr = extractExpr(initializer);
              let initVar: RawExpr = initExpr;
              if (initExpr.kind !== "var") {
                const tempName = freshName(`_destr${_destrCounter++}`);
                const initTs = _eraseGenerics(typeToString(initializer.getType()));
                result.push({ kind: "let", name: tempName, mutable: false, tsType: initTs, init: initExpr, line });
                initVar = { kind: "var", name: tempName };
              }
              for (const el of elements) {
                const inner = el.getNameNode();
                if (!Node.isIdentifier(inner)) {
                  throw new Error(`nested binding pattern in object destructuring not yet supported: ${el.getText()}`);
                }
                const localName = inner.getText();
                const propNode = el.getPropertyNameNode();
                const fieldName = propNode ? propNode.getText() : localName;
                const elTs = _eraseGenerics(typeToString(el.getType()));
                result.push({
                  kind: "let",
                  name: localName,
                  mutable: s.getDeclarationKind() === "let",
                  tsType: elTs,
                  init: { kind: "field", obj: initVar, field: fieldName },
                  line,
                });
              }
              continue;
            }
          }
        }
        // Destructuring rest: const { [k]: _, ...rest } = map → let rest = map.delete(k)
        if (!isHavoc && Node.isObjectBindingPattern(nameNode)) {
          const elements = nameNode.getElements();
          const restEl = elements.find(el => el.getDotDotDotToken());
          const computedEls = elements.filter(el => {
            const pn = el.getPropertyNameNode();
            return pn && Node.isComputedPropertyName(pn);
          });
          if (restEl && computedEls.length > 0) {
            const initializer = d.getInitializer();
            if (initializer) {
              let deleteInit: RawExpr = extractExpr(initializer);
              for (const cel of computedEls) {
                const pn = cel.getPropertyNameNode()!;
                const keyExpr = extractExpr((pn as any).getExpression());
                deleteInit = { kind: "call",
                  fn: { kind: "field", obj: deleteInit, field: "delete" },
                  args: [keyExpr] };
              }
              const declType = d.getType();
              result.push({
                kind: "let",
                name: restEl.getName(),
                mutable: s.getDeclarationKind() === "let",
                tsType: _eraseGenerics(typeToString(declType)),
                init: deleteInit,
                line,
              });
              continue;
            }
          }
        }
        const declType = d.getType();
        let init: RawExpr;
        if (isHavoc && !havocKey) {
          // Use explicit type from //@ havoc : Type, or initializer type (pre-cast), or declared type
          const initType = d.getInitializer()?.getType();
          init = { kind: "havoc", tsType: havocType ?? typeToString(initType ?? declType) };
        } else {
          const initializer = d.getInitializer();
          _havocKey = havocKey;
          if (initializer) {
            init = extractExpr(initializer);
          } else {
            // No initializer — emit a type-appropriate default so the emitted
            // Dafny binding `var x: T := <default>;` typechecks. The empty-
            // collection cases are picked up by dafny-emit's let case, which
            // adds an explicit `: T` annotation for inference.
            const tsType = _eraseGenerics(d.getTypeNode()?.getText() ?? typeToString(declType));
            const isOptional = / \| (null|undefined)\b/.test(tsType)
              || /^(null|undefined) \| /.test(tsType)
              || tsType.endsWith(" | undefined") || tsType.endsWith(" | null");
            const isArray = tsType.endsWith("[]") || /^Array</.test(tsType) || /^readonly /.test(tsType);
            const isMap = /^Map</.test(tsType);
            const isSet = /^Set</.test(tsType);
            if (isOptional)      init = { kind: "var" as const, name: "undefined" };
            else if (isArray)    init = { kind: "arrayLiteral" as const, elems: [] };
            else if (isMap)      init = { kind: "emptyCollection" as const, collectionType: "Map", tsType };
            else if (isSet)      init = { kind: "emptyCollection" as const, collectionType: "Set", tsType };
            else if (tsType === "number") init = { kind: "num" as const, value: 0 };
            else if (tsType === "boolean") init = { kind: "bool" as const, value: false };
            else if (tsType === "string")  init = { kind: "str" as const, value: "" };
            else init = { kind: "var" as const, name: "default" };
          }
          _havocKey = null;
        }
        // Use the source-level type annotation if present — ts-morph's
        // `d.getType()` strips `| undefined` from optional annotations.
        // When no annotation, fall back to ts-morph's inferred type — except
        // when the inference collapses to `any` (e.g. brownfield imports
        // where the imported declaration's shape is opaque to LS): in that
        // case leave null so resolve infers from the initializer's IR type
        // (which sees the declare-type stubs).
        const annotatedText = d.getTypeNode()?.getText();
        const inferred = annotatedText ? null : _eraseGenerics(typeToString(declType));
        const tsType: string | null = havocType
          ?? (annotatedText ? _eraseGenerics(annotatedText) : (inferred === "any" ? null : inferred));
        result.push({
          kind: "let",
          name: d.getName(),
          mutable: s.getDeclarationKind() === "let",
          tsType,
          init,
          line,
        });
      }
      continue;
    }

    if (Node.isWhileStatement(s)) {
      const bodyNode = s.getStatement();
      // A braceless body (`while (c) stmt`) is a single statement, not a Block;
      // wrap it so it isn't dropped (mirrors the for / for-of / if handlers).
      const bodyStmts = Node.isBlock(bodyNode) ? bodyNode.getStatements() : [bodyNode];
      const annots = collectLoopAnnotations(bodyStmts);
      result.push({
        kind: "while",
        cond: extractExpr(s.getExpression()),
        invariants: annots.filter(a => a.kind === "invariant").map(a => a.expr),
        decreases: annots.find(a => a.kind === "decreases")?.expr ?? null,
        doneWith: annots.find(a => a.kind === "done_with")?.expr ?? null,
        body: extractStmts(bodyStmts),
        line,
      });
      continue;
    }

    if (Node.isForOfStatement(s)) {
      const init = s.getInitializer();
      const names: string[] = [];
      if (Node.isVariableDeclarationList(init)) {
        const decl = init.getDeclarations()[0];
        const nameNode = decl?.getNameNode();
        if (nameNode && Node.isArrayBindingPattern(nameNode)) {
          for (const elem of nameNode.getElements()) {
            if (Node.isOmittedExpression(elem)) names.push("_");
            else if (Node.isBindingElement(elem)) names.push(elem.getNameNode().getText());
          }
        } else {
          names.push(decl?.getName() ?? "_");
        }
      } else {
        names.push("_");
      }
      // Unwrap Object.entries(expr) / Object.values(expr) to bare map iteration
      let iterableExpr = s.getExpression();
      if (Node.isCallExpression(iterableExpr)) {
        const callee = iterableExpr.getExpression();
        if (Node.isPropertyAccessExpression(callee) &&
            callee.getExpression().getText() === "Object") {
          const method = callee.getName();
          if ((method === "entries" || method === "values") && iterableExpr.getArguments().length === 1) {
            iterableExpr = iterableExpr.getArguments()[0] as Expression;
            // Object.values with single name → prepend "_" so it looks like [_, v] destructuring
            if (method === "values" && names.length === 1) {
              names.unshift("_");
            }
          }
        }
      }

      const bodyNode = s.getStatement();
      const bodyStmts = Node.isBlock(bodyNode) ? bodyNode.getStatements() : [bodyNode];
      const annots = collectLoopAnnotations(bodyStmts);
      result.push({
        kind: "forof",
        names,
        iterable: extractExpr(iterableExpr),
        invariants: annots.filter(a => a.kind === "invariant").map(a => a.expr),
        doneWith: annots.find(a => a.kind === "done_with")?.expr ?? null,
        body: extractStmts(bodyStmts),
        line,
      });
      continue;
    }

    // C-style for(init; cond; update) — desugar to:
    //   init;
    //   while (cond) { body; update }
    // The init's binding is forced mutable (update mutates it). The update is
    // a bare Expression in ts-morph (not wrapped in an ExpressionStatement),
    // so we route it through the same `desugarStmtExpr` helper that the
    // ExpressionStatement branch above uses — `i++` etc. end up as RawAssign
    // exactly as they would if written as their own statement.
    if (Node.isForStatement(s)) {
      const init = s.getInitializer();
      const cond = s.getCondition();
      const incrementor = s.getIncrementor();
      const bodyNode = s.getStatement();
      const bodyStmts = Node.isBlock(bodyNode) ? bodyNode.getStatements() : [bodyNode];
      const annots = collectLoopAnnotations(bodyStmts);

      if (!init || !Node.isVariableDeclarationList(init))
        throw new Error(`for(...) at line ${line}: only variable-declaration init supported`);
      // Hoist the counter declarations, renaming any that would collide once
      // lifted out of the loop scope (see forCounterRename). The renames are
      // then applied to the loop's own desugared pieces below.
      const hoisted: RawStmt[] = [];
      const renames: [string, string][] = [];
      for (const decl of init.getDeclarations()) {
        const fresh = forCounterRename(decl, s);
        const name = fresh ?? decl.getName();
        if (fresh) renames.push([decl.getName(), fresh]);
        const tsType = decl.getTypeNode()?.getText() ?? typeToString(decl.getType());
        const initExpr = decl.getInitializer();
        if (!initExpr) throw new Error(`for(...) at line ${line}: missing initializer for ${name}`);
        hoisted.push({
          kind: "let", name, mutable: true, tsType,
          init: extractExpr(initExpr as Expression),
          line: decl.getStartLineNumber(),
        });
      }

      let extractedBody = extractStmts(bodyStmts);
      if (incrementor) {
        const incLine = incrementor.getStartLineNumber();
        const asStmt = desugarStmtExpr(incrementor, incLine);
        if (!asStmt) throw new Error(`for(...) at line ${line}: incrementor must be an assignment, compound assignment, or ++/--`);
        // The loop variable update runs at the bottom of every iteration. A
        // `continue` in the body would skip it, so emit a copy of the update
        // immediately before each same-scope `continue` (transform's
        // eliminateTopLevelContinue then turns `if (X) { update; continue }`
        // into `if (X) { update } else { rest }`). Nested `while`/`for-of`
        // loops own their continue scope and are left untouched.
        extractedBody = insertUpdateBeforeContinue(extractedBody, asStmt);
        extractedBody.push(asStmt);
      }

      let condExpr: RawExpr = cond ? extractExpr(cond) : { kind: "bool", value: true };
      let invariants = annots.filter(a => a.kind === "invariant").map(a => a.expr);
      let decreases = annots.find(a => a.kind === "decreases")?.expr ?? null;
      let doneWith = annots.find(a => a.kind === "done_with")?.expr ?? null;
      for (const [from, to] of renames) {
        for (let k = 0; k < hoisted.length; k++) hoisted[k] = renameRawStmt(hoisted[k], from, to);
        condExpr = renameRawExpr(condExpr, from, to);
        extractedBody = renameRawStmts(extractedBody, from, to);
        invariants = invariants.map(inv => renameSpec(inv, from, to));
        decreases = decreases ? renameSpec(decreases, from, to) : null;
        doneWith = doneWith ? renameSpec(doneWith, from, to) : null;
      }

      result.push(...hoisted);
      result.push({
        kind: "while",
        cond: condExpr,
        invariants,
        decreases,
        doneWith,
        body: extractedBody,
        line,
      });
      continue;
    }

    // for...in: for (const k in obj) → treat as forof with single key name
    if (Node.isForInStatement(s)) {
      const init = s.getInitializer();
      let name = "_";
      if (Node.isVariableDeclarationList(init)) {
        name = init.getDeclarations()[0]?.getName() ?? "_";
      }
      const bodyNode = s.getStatement();
      const bodyStmts = Node.isBlock(bodyNode) ? bodyNode.getStatements() : [bodyNode];
      const annots = collectLoopAnnotations(bodyStmts);
      result.push({
        kind: "forof",
        names: [name],
        iterable: extractExpr(s.getExpression()),
        invariants: annots.filter(a => a.kind === "invariant").map(a => a.expr),
        doneWith: annots.find(a => a.kind === "done_with")?.expr ?? null,
        body: extractStmts(bodyStmts),
        line,
      });
      continue;
    }

    if (Node.isIfStatement(s)) {
      const thenNode = s.getThenStatement();
      const elseNode = s.getElseStatement();
      result.push({
        kind: "if",
        cond: extractExpr(s.getExpression()),
        then: Node.isBlock(thenNode) ? extractStmts(thenNode.getStatements()) : extractStmts([thenNode]),
        else: elseNode
          ? Node.isBlock(elseNode) ? extractStmts(elseNode.getStatements()) : extractStmts([elseNode])
          : [],
        line,
      });
      continue;
    }

    if (Node.isSwitchStatement(s)) {
      const exprNode = s.getExpression();
      const exprAst = extractExpr(exprNode);
      const discriminant = exprAst.kind === "field" ? exprAst.field : "";
      const switchExpr = exprAst.kind === "field" ? exprAst.obj : exprAst;

      const cases: { label: string; body: RawStmt[] }[] = [];
      let defaultBody: RawStmt[] = [];
      // Two JS-`switch` faithfulness concerns the Dafny `match` doesn't share:
      //  (1) Fall-through: stacked `case A: case B: body` is several clauses
      //      where the leading ones have no statements; those labels share the
      //      next clause's body (we duplicate it per label).
      //  (2) `break` is the switch exit, not a loop break. We extract the full
      //      body (extractStmts flattens `{ }` blocks but keeps loop bodies
      //      nested) and strip the *top-level* breaks — so a `break` written
      //      inside a `{ }` case block is stripped, while a `break` inside a
      //      nested loop stays put.
      const stripExitBreaks = (b: RawStmt[]) => b.filter(st => st.kind !== "break");
      const isExit = (st: RawStmt | undefined) => !!st && ["break", "return", "throw", "continue"].includes(st.kind);
      // Resolve JS fall-through positionally: a clause's effective body is its
      // own statements concatenated with each following clause's statements up
      // to and including the first clause that ends in break/return/throw (or
      // the switch end). This covers both empty stacked labels (`case A: case
      // B: body`) and a *non-empty* case that falls through (`case A: sA; case
      // B: ...`) — the stripped breaks are the switch exits.
      const clauseInfos = s.getClauses().map(clause => {
        const stmts = extractStmts(clause.getStatements());
        let label: string | null = null;
        if (Node.isCaseClause(clause)) {
          const labelExpr = extractExpr(clause.getExpression());
          if (labelExpr.kind !== "str") {
            throw new Error(`Unsupported switch case at line ${clause.getStartLineNumber()}: expected a string literal`);
          }
          label = labelExpr.value;
        }
        return {
          label,
          stmts,
          exits: isExit(stmts[stmts.length - 1]),
        };
      });
      const fallThroughBody = (start: number): RawStmt[] => {
        let body: RawStmt[] = [];
        for (let j = start; j < clauseInfos.length; j++) {
          body = body.concat(clauseInfos[j]!.stmts);
          if (clauseInfos[j]!.exits) break;
        }
        return stripExitBreaks(body);
      };
      for (let i = 0; i < clauseInfos.length; i++) {
        const c = clauseInfos[i]!;
        if (c.label === null) defaultBody = fallThroughBody(i);
        else cases.push({ label: c.label, body: fallThroughBody(i) });
      }
      result.push({ kind: "switch", expr: switchExpr, discriminant, cases, defaultBody, line });
      continue;
    }

    if (Node.isReturnStatement(s)) {
      const expr = s.getExpression();
      const tagged = expr ? taggedMatchStatement(expr, line) : null;
      if (tagged) { result.push(tagged); continue; }
      // Bare `return;` in a `T | undefined` function → emit `return None;`
      // ("undefined" is mapped to None by dafny-emit). For void-returning
      // functions this would emit the wrong shape, but lsc has no current
      // examples of explicit bare return in void functions; revisit if one
      // appears.
      // `//@ havoc <key>` on a return abstracts the matching calls or new
      // expressions inside the returned expression — there is no variable to
      // hang a whole-value havoc on, so only the key form applies here.
      const value = withHavocKey(havocDirective(s)?.key ?? null, () =>
        expr ? extractExpr(expr) : { kind: "var" as const, name: "undefined" });
      result.push({ kind: "return", value, line });
      continue;
    }

    if (Node.isBreakStatement(s)) {
      result.push({ kind: "break", line });
      continue;
    }

    if (Node.isContinueStatement(s)) {
      result.push({ kind: "continue", line });
      continue;
    }

    if (Node.isExpressionStatement(s)) {
      const expr = s.getExpression();
      // //@ havoc before `x = e` — discard the RHS, assign a nondeterministic
      // value of x's type. Only applies to plain `=` with an identifier LHS;
      // compound assigns, `arr[i] = v`, and `x++` fall through to desugaring.
      const havoc = havocDirective(s);
      if (havoc && !havoc.key && Node.isBinaryExpression(expr)
          && expr.getOperatorToken().getText() === "="
          && Node.isIdentifier(expr.getLeft())) {
        const target = expr.getLeft().getText();
        const tsType = havoc.type ?? _eraseGenerics(typeToString(expr.getLeft().getType()));
        result.push({ kind: "assign", target, value: { kind: "havoc", tsType }, line });
        continue;
      }
      const asAssign = desugarStmtExpr(expr, line);
      result.push(asAssign ?? { kind: "expr", expr: extractExpr(expr), line });
      continue;
    }

    if (Node.isThrowStatement(s)) {
      result.push({ kind: "throw", line });
      continue;
    }

    // Block statement: { ... } — flatten into parent
    if (Node.isBlock(s)) {
      result.push(...extractStmts(s.getStatements()));
      continue;
    }

    throw new Error(`Unsupported statement at line ${line}: ${s.getText().slice(0, 80)}`);
  }
  // Ghost comments after the last statement (before closing brace) appear as sibling trivia nodes
  if (stmts.length > 0) {
    const last = stmts[stmts.length - 1];
    const line = last.getStartLineNumber();
    for (const sib of last.getNextSiblings()) {
      const text = sib.getText().trim();
      if (!text.startsWith(PREFIX)) continue;
      const content = text.slice(PREFIX.length);
      // assert expr
      if (content.startsWith("assert ")) {
        result.push({ kind: "assert", expr: content.slice(7).trim(), line });
        continue;
      }
      // assume expr — trusted form of assert; emitted as `assume P;` in Dafny.
      if (content.startsWith("assume ")) {
        result.push({ kind: "assert", expr: content.slice(7).trim(), line, assumed: true });
        continue;
      }
      if (!content.startsWith("ghost ")) continue;
      const ghostBody = content.slice(6).trim();
      const letMatch = ghostBody.match(/^let\s+(\w+)(?:\s*:\s*([^=]+?))?\s*=\s*(.+)$/);
      if (letMatch) {
        result.push({ kind: "ghostLet", name: letMatch[1], tsType: letMatch[2]?.trim() ?? null, init: letMatch[3].trim(), line });
        continue;
      }
      const assignMatch = ghostBody.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        result.push({ kind: "ghostAssign", target: assignMatch[1], value: assignMatch[2].trim(), line });
      }
    }
  }
  return result;
}

// ── Function extraction ──────────────────────────────────────

function extractFunction(fn: FunctionDeclaration, parentAnnotations?: Annotation[]): RawFunction {
  const prevInFn = _inFunctionExtraction;
  _inFunctionExtraction = true;
  try {
    return extractFunctionInner(fn, parentAnnotations);
  } finally {
    _inFunctionExtraction = prevInFn;
  }
}
function extractFunctionInner(fn: FunctionDeclaration, parentAnnotations?: Annotation[]): RawFunction {
  // A `<T extends B>` bound is handled one of two ways. When B is a modelable
  // type (a record/nominal), substitute T with B — a body that reads T's fields
  // (e.g. `x.id`) then typechecks against B. When B is a union/intersection we
  // can't model as one Dafny type (e.g. `string & {}` tricks), keep T as a Dafny
  // type param instead; such a T must be phantom (any field read won't typecheck).
  _typeParamMap = new Map();
  _reservedForCounterNames = new Set();
  const typeParams: string[] = [];
  for (const tp of fn.getTypeParameters?.() ?? []) {
    const constraint = tp.getConstraint();
    const ct = constraint?.getType();
    if (constraint && !ct?.isUnion() && !ct?.isIntersection()) _typeParamMap.set(tp.getName(), constraint.getText());
    else typeParams.push(tp.getName());
  }

  const body = fn.getBody();

  // Expression-body arrow: wrap in implicit return
  let extractedBody: RawStmt[];
  let annots: Annotation[];
  if (body && !Node.isBlock(body)) {
    const expr = extractExpr(body as Expression);
    extractedBody = [{ kind: "return", value: expr, line: body.getStartLineNumber() }];
    annots = parentAnnotations ?? collectFunctionAnnotations(fn);
  } else if (body && Node.isBlock(body)) {
    extractedBody = extractStmts(body.getStatements());
    annots = collectFunctionAnnotations(fn);
  } else {
    throw new Error(`${(fn as any).getName?.() ?? "arrow"}: function has no body`);
  }

  const typeAnnotations: { name: string; type: string }[] = [];
  for (const a of annots) {
    if (a.kind === "type") {
      const parts = a.expr.split(/\s+/);
      if (parts.length === 2) typeAnnotations.push({ name: parts[0], type: parts[1] });
    }
  }

  return {
    name: (fn as any).getName?.() ?? "<anonymous>",
    exported: false,  // set in extractModule against the source file's export surface
    typeParams,
    // Original TS parameter grouping, before the flatten below loses it. `defaults` carries
    // each bound name's default initializer text (omitted when none) for TS-targeting consumers.
    tsParams: fn.getParameters().map(p => {
      const nameNode = p.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        const els = nameNode.getElements();
        const defaults: Record<string, string> = {};
        for (const el of els) { const init = el.getInitializer(); if (init) defaults[el.getName()] = init.getText(); }
        const binds = els.map(el => el.getName());
        return Object.keys(defaults).length ? { kind: "object" as const, binds, defaults } : { kind: "object" as const, binds };
      }
      if (p.isRestParameter()) return { kind: "rest" as const, binds: [p.getName()] };
      const init = p.getInitializer();
      return init
        ? { kind: "simple" as const, binds: [p.getName()], defaults: { [p.getName()]: init.getText() } }
        : { kind: "simple" as const, binds: [p.getName()] };
    }),
    params: fn.getParameters().flatMap(p => {
      // Flatten destructured object params into individual params
      const nameNode = p.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        const type = p.getType();
        // `//@ declare-type` types are invisible to the TS checker, so
        // `type.getProperty` finds nothing for them and the bindings would
        // collapse to `unknown`. Fall back to the declared record's field types.
        const declTypeName = p.getTypeNode()?.getText();
        const declFields = declTypeName
          ? _synthArrayUnions?.find(d => d.name === declTypeName && d.kind === "record")?.fields
          : undefined;
        return nameNode.getElements().map(el => {
          const name = el.getName();
          const propType = type.getProperty(name)?.getTypeAtLocation(p);
          if (propType) return { name, tsType: typeToString(propType) };
          const declTy = declFields?.find(f => f.name === name)?.tsType;
          return { name, tsType: declTy ?? "unknown" };
        });
      }
      // Syntactic union nodes go through _tsTypeFromUnionNode so synth fires
      // and aliases are preserved. Non-union nodes use the syntactic text;
      // when no annotation is present, fall back to the computed type
      // (e.g., `eof = false` infers `boolean` from the default value).
      const tn = p.getTypeNode();
      let tsType: string;
      if (tn && Node.isUnionTypeNode(tn)) {
        tsType = _eraseGenerics(_tsTypeFromUnionNode(tn));
      } else if (tn) {
        tsType = _eraseGenerics(tn.getText());
      } else {
        tsType = _eraseGenerics(typeToString(p.getType()));
      }
      if (p.hasQuestionToken()) tsType = `${tsType} | undefined`;
      return [{ name: p.getName(), tsType }];
    }),
    returnType: (() => {
      // `async` with no `await`: the `Promise<T>` wrapper is just the calling
      // convention (the body returns T-typed values), so unwrap to T. Gated on
      // no `await` — that's the suspension point we can't model, and it only
      // type-checks inside `async`, so the gate is self-justifying. With `await`
      // present we leave `Promise<...>` (unmodellable) rather than atomize it.
      const isAsync = (fn as { isAsync?: () => boolean }).isAsync?.() ?? false;
      const noAwait = fn.getDescendantsOfKind(SyntaxKind.AwaitExpression).length === 0;
      if (isAsync && noAwait) {
        const args = fn.getReturnType().getTypeArguments();
        if (args.length === 1) {
          if (args[0].isAny()) return "unknown";
          return _eraseGenerics(typeToString(args[0]));
        }
        return "void";  // Promise<void>
      }
      const node = fn.getReturnTypeNode();
      // A type predicate (`x is T` / `asserts x is T`) is a `boolean` at
      // runtime; the narrowing it performs is a TS-only refinement with no
      // counterpart in the model. Without this, `getText()` yields "x is T"
      // and the type mapper reads the subject name as an opaque type.
      if (node && node.getKind() === SyntaxKind.TypePredicate) return "boolean";
      if (node && Node.isUnionTypeNode(node)) return _eraseGenerics(_tsTypeFromUnionNode(node));
      if (node) return _eraseGenerics(node.getText());
      const inferred = fn.getReturnType();
      if (inferred.isAny()) return "unknown";
      return _eraseGenerics(typeToString(inferred));
    })(),
    requires: annots.filter(a => a.kind === "requires").map(a => a.expr),
    ensures: annots.filter(a => a.kind === "ensures").map(a => a.expr),
    contract: annots.filter(a => a.kind === "contract").map(a => a.expr),
    decreases: annots.find(a => a.kind === "decreases")?.expr ?? null,
    pure: hasPureAnnotation(fn, body && Node.isBlock(body) ? body.getStatements() as Node[] : undefined),
    opaque: hasBareFunctionAnnotation(fn, "opaque", body && Node.isBlock(body) ? body.getStatements() as Node[] : undefined),
    reveals: annots.filter(a => a.kind === "reveal").map(a => a.expr),
    autohavoc: false,  // set in extractModule (file-level directive or per-function)
    typeAnnotations,
    body: extractedBody,
    line: fn.getStartLineNumber(),
  };
}

// ── Module extraction ────────────────────────────────────────

export function extractModule(sourceFile: SourceFile, options: LscOptions = DEFAULT_OPTIONS,
  validateDependency: (source: SourceFile) => void = () => {}): RawModule {
  _extractOptions = options;
  _validateDependency = validateDependency;
  // Seed the fresh-name check (names.ts) before anything mints: every
  // Identifier token in the module, a deliberate over-approximation.
  setUserNames(new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).map(i => i.getText())));
  const typeDecls: TypeDeclInfo[] = [];
  // Cross-file calls are auto-externed: ts-morph resolves the call's symbol;
  // if it's defined in a different source file we treat the symbol as opaque
  // and emit a body-less `function {:axiom}` in Dafny. Populated by
  // `extractExpr` during call extraction (only symbols *actually used* end up
  // here), deduped by qualified name.
  _externs.clear();
  _externContractConsts.clear();
  _externSigTypes.length = 0;

  // A contract may call an imported function that no body calls (a mutant, or a
  // clause stated in terms of the import). Body extraction would never declare
  // it, so register every named import a module contract line calls.
  const contractText = sourceFile.getFullText().split("\n")
    .filter(line => /^[ \t]*\/\/@[ \t]+(?:requires|ensures|invariant|assert|decreases)\b/.test(line))
    .join("\n");
  if (contractText !== "") {
    for (const imp of sourceFile.getImportDeclarations()) {
      if (imp.isTypeOnly()) continue;
      for (const named of imp.getNamedImports()) {
        if (named.isTypeOnly()) continue;
        const local = named.getAliasNode() ?? named.getNameNode();
        if (!Node.isIdentifier(local)) continue;
        if (new RegExp(String.raw`\b${local.getText()}\s*\(`).test(contractText)) registerExternIfCrossFile(local, sourceFile);
      }
    }
  }

  // Match a `//@ <kw>` directive only as the first non-whitespace on a line,
  // so prose mentioning an annotation does not activate it.
  function hasLineDirective(text: string, kw: string): boolean {
    return new RegExp(String.raw`^[ \t]*//@ ${kw}\b`, "m").test(text);
  }

  // Declaration-level directives must be attached as leading comments. Do
  // not scan a function's whole body: a statement-level `//@ skip` inside it
  // must not omit the enclosing function.
  function hasLeadingDirective(node: Node, kw: string): boolean {
    return node.getLeadingCommentRanges().some(r => hasLineDirective(r.getText(), kw));
  }

  // Share the module's ts-morph Project with parseTsType (scratch source file
  // for type-string parsing). Done before declare-type parsing so any
  // parseTsType call downstream uses the same Project.
  initTypeParser(sourceFile.getProject());

  // Activate the synthesized-array-union accumulator. typeToString registers
  // a discriminated-union TypeDeclInfo for any `T[] | U` shape it encounters,
  // pushing into `typeDecls` so resolve sees the synth as a regular user type.
  // Set before declare-type parsing so declare-type field types can also synth.
  _synthArrayUnions = typeDecls;

  // `//@ declare-type Name { f1: T1, ... }` — record form.
  // `//@ declare-type Name = TsType`         — alias form (e.g. `Ruleset = Rule[]`).
  function parseDeclareType(body: string) {
    const recordMatch = body.match(/^(\w+)\s*(?:<([^>]+)>)?\s*\{(.+)\}$/);
    if (recordMatch) {
      const name = recordMatch[1];
      // `<T extends B>` → bare `T`: a Dafny type param, like the def path.
      const typeParams = recordMatch[2]?.split(",").map(s => s.trim().split(/\s+extends\s+/)[0].trim()).filter(Boolean);
      // Split on `,` OR `;` — TS object types allow both.
      const fields = recordMatch[3].split(/[,;]/).map(f => f.trim()).filter(Boolean).map(f => {
        const [fname, ftype] = f.split(":").map(s => s.trim());
        const synth = _synthFromTsTypeString(ftype);
        return { name: fname, tsType: synth ?? ftype };
      });
      typeDecls.push({ name, kind: "record", fields, ...(typeParams?.length ? { typeParams } : {}) });
      return;
    }
    const aliasMatch = body.match(/^(\w+)\s*=\s*(.+)$/);
    if (aliasMatch) {
      const rhs = aliasMatch[2].trim();
      // A string-literal union (`= "a" | "b" | …`) becomes an enum datatype —
      // the same shape a real string-union alias resolves to. Dafny has no
      // string-literal type, so a plain alias (`type X = "a" | "b"`) would be
      // invalid. Other RHS forms (`Rule[]`, `number`, `A | B`) fall through.
      const parts = rhs.split("|").map(s => s.trim());
      const lits = parts.map(p => p.match(/^["'](.+)["']$/));
      if (parts.length >= 2 && lits.every(m => m !== null)) {
        typeDecls.push({ name: aliasMatch[1], kind: "string-union", values: lits.map(m => m![1]) });
      } else {
        typeDecls.push({ name: aliasMatch[1], kind: "alias", aliasOf: rhs });
      }
    }
  }

  for (const range of sourceFile.getLeadingCommentRanges()) {
    const text = range.getText().trim();
    if (text.startsWith("//@ declare-type ")) parseDeclareType(text.slice("//@ declare-type ".length));
  }
  for (const stmt of sourceFile.getStatements()) {
    for (const range of stmt.getLeadingCommentRanges()) {
      const text = range.getText().trim();
      if (text.startsWith("//@ declare-type ")) parseDeclareType(text.slice("//@ declare-type ".length));
    }
  }
  _currentSourceFile = sourceFile;

  // Pre-scan for collapsed single-variant unions so typeToString can recover alias names.
  // TypeScript collapses `type X = | { kind: 'A'; ... }` to a plain object type, losing
  // the alias. We record a fingerprint (sorted property names) → alias name mapping.
  _collapsedUnionMap = new Map();
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isTypeAliasDeclaration(stmt)) {
      const type = stmt.getType();
      if (!type.isUnion() && type.isObject() && !type.isIntersection()) {
        const srcText = stmt.getTypeNode()?.getText() ?? "";
        if (srcText.includes("|") && findDiscriminant([type])) {
          const props = type.getProperties().map(p => p.getName()).sort().join(",");
          _collapsedUnionMap.set(props, stmt.getName());
        }
      }
    }
  }

  // Extract type declarations in source order to respect dependencies
  // Skip types already declared via //@ declare-type
  const declaredNames = new Set(typeDecls.map(d => d.name));
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isTypeAliasDeclaration(stmt) && !declaredNames.has(stmt.getName())) {
      const extra: TypeDeclInfo[] = [];
      const info = extractTypeDecl(stmt, extra);
      typeDecls.push(...extra);
      if (info) typeDecls.push(info);
    } else if (Node.isInterfaceDeclaration(stmt) && !declaredNames.has(stmt.getName())) {
      const extra: TypeDeclInfo[] = [];
      const info = extractInterface(stmt, extra);
      // Synthetic types from inline objects must precede the parent type
      typeDecls.push(...extra);
      if (info) typeDecls.push(info);
    }
  }

  // Extract module-level const declarations
  const constants: RawConst[] = [];
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      if (hasLeadingDirective(stmt, "skip")) continue;
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        if (stmt.getDeclarationList().getFlags() & 2 /* const */) {
          const init = decl.getInitializer();
          // Skip huge string constants — they crash the verifier and have no verification value
          const initType = decl.getType();
          const isHugeString = (initType.isString() || initType.isStringLiteral()) && (init as Expression).getText().length > 200;
          // Skip anonymous-object consts (e.g., `const Util = { dotMatch(s, p) { ... } }`).
          // ts-morph names these `__type` / `__object`; Dafny has no model for
          // object-namespace-with-methods. The methods themselves should be
          // extracted via the function path if marked `//@ verify`.
          const declTsType = typeToString(decl.getType());
          const isAnonObject = declTsType.startsWith("__");
          if (init && !isHugeString && !isAnonObject && !Node.isArrowFunction(init)) {
            try {
              constants.push({
                name: decl.getName(),
                tsType: declTsType,
                value: extractExpr(init as Expression),
              });
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e);
              throw new Error(
                `Failed to extract const '${decl.getName()}' at ${sourceFile.getBaseName()}:${decl.getStartLineNumber()}: ${reason}`,
              );
            }
          }
        }
      }
    }
  }

  constants.unshift(...importedConstants(sourceFile, new Set(constants.map(c => c.name))));

  // Collect all function-like declarations: function declarations + const arrow functions
  const allFns: { name: string; node: FunctionDeclaration; parentStmt?: Node }[] = [];
  for (const fn of sourceFile.getFunctions()) {
    allFns.push({ name: fn.getName() ?? "<anonymous>", node: fn });
  }
  // const f = (...) => expr  OR  const f = (...) => { ... }
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        const init = decl.getInitializer();
        if (init && Node.isArrowFunction(init)) {
          allFns.push({ name: decl.getName(), node: init as unknown as FunctionDeclaration, parentStmt: stmt });
        }
      }
    }
  }
  // Top-level inline closures: a handler passed directly to a module-level call,
  // e.g. `app.get("/x", (req, res) => { //@ verify ... })`. "Move" each such
  // closure to the top level by extracting it as a synthetic named function.
  // Only top-level call arguments are considered (not nested lambdas), and only
  // closures carrying a //@ verify (so ordinary callbacks aren't pulled in). The
  // name is derived from the call's method and route literal (e.g. get_x).
  const usedNames = new Set(allFns.map(f => f.name));
  const sanitizeIdent = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "handler";
  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) continue;
    const call = stmt.getExpression();
    if (!Node.isCallExpression(call)) continue;
    const callee = call.getExpression();
    const method = Node.isPropertyAccessExpression(callee) ? callee.getName()
      : Node.isIdentifier(callee) ? callee.getText() : "handler";
    const routeArg = call.getArguments().find(a => Node.isStringLiteral(a));
    const route = routeArg && Node.isStringLiteral(routeArg) ? routeArg.getLiteralValue() : "";
    for (const arg of call.getArguments()) {
      if (!Node.isArrowFunction(arg)) continue;
      if (!hasLineDirective(arg.getFullText(), "verify")) continue;
      const base = sanitizeIdent(route ? `${method}_${route}` : method);
      let name = base, n = 2;
      while (usedNames.has(name)) name = `${base}_${n++}`;
      usedNames.add(name);
      allFns.push({ name, node: arg as unknown as FunctionDeclaration, parentStmt: stmt });
    }
  }

  // `//@ extern` on a same-file declaration: register the function as an
  // opaque axiom (signature + any //@ requires/ensures), skip its body. Use
  // when the function is outside LS's verification model — e.g., wraps a
  // regex — but its callers should still be verifiable against an
  // uninterpreted predicate. Parallel to auto-extern for cross-file calls,
  // and emitted the same way (`function {:axiom} foo(...)` in Dafny).
  function hasSkip(f: { node: FunctionDeclaration; parentStmt?: Node }) {
    return hasLeadingDirective(f.parentStmt ?? f.node, "skip")
      || (!!f.parentStmt && hasLeadingDirective(f.node, "skip"));
  }
  function hasExtern(f: { node: FunctionDeclaration; parentStmt?: Node }) {
    if (hasLineDirective(f.node.getFullText(), "extern")) return true;
    if (f.parentStmt) {
      for (const r of f.parentStmt.getLeadingCommentRanges()) {
        if (hasLineDirective(r.getText(), "extern")) return true;
      }
    }
    return false;
  }
  // `//@ extern NS.method` registers the extern under a *dotted* qualified name,
  // so a real `NS.method(args)` call dispatches to it (resolve.ts) with no
  // wrapper — e.g. `//@ extern fs.readFileSync` lets you call `fs.readFileSync`
  // directly while still discharging its `//@ requires`. The function declaration
  // just carries the signature/contract; its own name is unused.
  function externName(f: { node: FunctionDeclaration; parentStmt?: Node }): string | null {
    const re = /^[ \t]*\/\/@ extern[ \t]+(\S+)/m;
    const m = f.node.getFullText().match(re);
    if (m) return m[1];
    if (f.parentStmt) {
      for (const r of f.parentStmt.getLeadingCommentRanges()) {
        const m2 = r.getText().match(re);
        if (m2) return m2[1];
      }
    }
    return null;
  }
  for (const f of allFns) {
    if (hasSkip(f) || !hasExtern(f)) continue;
    const qualified = externName(f) ?? f.name;
    const flat = qualified.replace(/\./g, "_");
    if (_externs.has(qualified)) continue;
    const sig = f.node.getType().getCallSignatures()[0];
    if (!sig) continue;
    // Bare names, dropping `extends B` — same as the def path.
    const typeParams = sig.getTypeParameters().map(tp => tp.getText().split(/\s+extends\s+/)[0].trim());
    // Normalize via typeToString (not raw getText): resolves declare-type
    // shadows and yields bare names, so a param typed by an unreachable import
    // becomes `AgentMessage`, not `import("/abs/path").AgentMessage`.
    const params = sig.getParameters().map(p => ({
      name: p.getName(),
      tsType: typeToString(p.getTypeAtLocation(f.node)),
    }));
    const returnType = typeToString(sig.getReturnType());
    const annots = collectFunctionAnnotations(f.node);
    const requires = annots.filter(a => a.kind === "requires").map(a => a.expr);
    const ensures = annots.filter(a => a.kind === "ensures").map(a => a.expr);
    _externs.set(qualified, {
      qualified, flat, typeParams, params, returnType, requires, ensures,
      impure: externIsImpure(f.node, qualified, f.parentStmt),
    });
  }

  // If any function has //@ verify, only extract those (brownfield mode).
  // For expression-body arrows, //@ verify may be on the parent variable statement.
  function hasVerify(f: { node: FunctionDeclaration; parentStmt?: Node }) {
    if (hasLineDirective(f.node.getFullText(), "verify")) return true;
    if (f.parentStmt) {
      for (const r of f.parentStmt.getLeadingCommentRanges()) {
        if (hasLineDirective(r.getText(), "verify")) return true;
      }
    }
    return false;
  }
  const nonExternFns = allFns.filter(f => !hasSkip(f) && !hasExtern(f));
  const hasVerifiedClassMethod = sourceFile.getClasses().some(cls =>
    !hasLeadingDirective(cls, "skip") && cls.getMethods().some(method =>
      !hasLeadingDirective(method, "skip") && hasLineDirective(method.getFullText(), "verify"),
    ),
  );
  const hasVerifyDirective = nonExternFns.some(hasVerify) || hasVerifiedClassMethod;
  const fnsToExtract = hasVerifyDirective ? nonExternFns.filter(hasVerify) : nonExternFns;

  // `//@ autohavoc` — enable the auto-havoc abstraction (see autohavoc.ts).
  // File-level: a directive at column 0 (top of file) enables it for every
  // function. Per-function: the annotation attached to a function (or its
  // parent variable statement), mirroring `//@ verify`.
  const fileAutohavoc = /^\/\/@ autohavoc\b/m.test(sourceFile.getFullText());
  function hasAutohavoc(f: { node: FunctionDeclaration; parentStmt?: Node }) {
    if (fileAutohavoc) return true;
    if (hasLineDirective(f.node.getFullText(), "autohavoc")) return true;
    if (f.parentStmt) {
      for (const r of f.parentStmt.getLeadingCommentRanges()) {
        if (hasLineDirective(r.getText(), "autohavoc")) return true;
      }
    }
    return false;
  }

  // The module's export surface, by name — covers inline `export function`,
  // `export { a, b }`, re-exports, and `export const`. Consumers (e.g. the guard
  // plugin) use this to wrap only the boundary, not internal helpers.
  const exportedNames = new Set<string>(sourceFile.getExportedDeclarations().keys());
  const functions = fnsToExtract.map(f => {
    // For expression-body arrows, annotations come from the parent variable statement
    const parentAnnots = f.parentStmt ? parseAnnotations(f.parentStmt) : undefined;
    const raw = extractFunction(f.node, parentAnnots);
    raw.name = f.name;  // use the const name, not "<anonymous>"
    raw.exported = exportedNames.has(f.name);
    raw.autohavoc = hasAutohavoc(f);
    return raw;
  });

  // Resolve type references in function signatures via ts-morph's type
  // checker — walk the TypeNode tree, resolve each TypeReferenceNode to its
  // declaration through symbol resolution, recurse. This is the principled
  // replacement for an earlier regex-based walker that extracted identifier
  // names from tsType strings and searched the whole project by name — that
  // approach had ambiguous resolution (name collisions in generated files
  // could shadow what the user actually imported).
  const knownTypeNames = new Set(typeDecls.map(d => d.name));
  function resolveTypeNodeRefs(tn: Node | undefined) {
    if (!tn) return;
    if (Node.isTypeReference(tn)) {
      // An imported name's symbol is the import; its declarations are the aliased symbol's.
      const named = tn.getTypeName().getSymbol();
      const sym = named?.isAlias() ? named.getAliasedSymbol() ?? named : named;
      if (sym) {
        for (const d of sym.getDeclarations()) {
          // Skip ambient/built-in declarations: library `.d.ts` files (lib.dom.d.ts,
          // node_modules typings) describe runtime/host types, not user code
          // — backends map these directly (`Map<K,V>` → `map<K,V>`) without
          // needing the interface dump. A project's own declaration file, such
          // as a module's emitted declaration read through `import type`, is
          // user code and is read.
          if (d.getSourceFile().isDeclarationFile() && d.getSourceFile().isInNodeModules()) continue;
          let added: TypeDeclInfo | null = null;
          if (Node.isTypeAliasDeclaration(d) && !knownTypeNames.has(d.getName())) {
            const extra: TypeDeclInfo[] = [];
            added = extractTypeDecl(d, extra);
            typeDecls.push(...extra);
            if (added) { typeDecls.push(added); knownTypeNames.add(d.getName()); }
          } else if (Node.isInterfaceDeclaration(d) && !knownTypeNames.has(d.getName())) {
            const extra: TypeDeclInfo[] = [];
            added = extractInterface(d, extra);
            typeDecls.push(...extra);
            if (added) { typeDecls.push(added); knownTypeNames.add(d.getName()); }
          }
          // Recurse into the newly-added declaration's TypeNodes — preferring
          // the actual AST over re-parsing tsType strings.
          if (added) {
            if (Node.isTypeAliasDeclaration(d)) resolveTypeNodeRefs(d.getTypeNode());
            else if (Node.isInterfaceDeclaration(d)) {
              for (const m of d.getProperties()) resolveTypeNodeRefs(m.getTypeNode());
            }
          }
        }
      }
      for (const a of tn.getTypeArguments()) resolveTypeNodeRefs(a);
      return;
    }
    if (Node.isUnionTypeNode(tn) || Node.isIntersectionTypeNode(tn)) {
      for (const arm of tn.getTypeNodes()) resolveTypeNodeRefs(arm);
      return;
    }
    if (Node.isArrayTypeNode(tn)) { resolveTypeNodeRefs(tn.getElementTypeNode()); return; }
    if (Node.isTupleTypeNode(tn)) { for (const el of tn.getElements()) resolveTypeNodeRefs(el); return; }
    if (Node.isParenthesizedTypeNode(tn)) { resolveTypeNodeRefs(tn.getTypeNode()); return; }
    if (Node.isFunctionTypeNode(tn)) {
      for (const p of tn.getParameters()) resolveTypeNodeRefs(p.getTypeNode());
      resolveTypeNodeRefs(tn.getReturnTypeNode());
      return;
    }
    if (Node.isTypeLiteral(tn)) {
      for (const m of tn.getProperties()) resolveTypeNodeRefs(m.getTypeNode());
      return;
    }
  }
  for (const f of fnsToExtract) {
    for (const p of f.node.getParameters()) resolveTypeNodeRefs(p.getTypeNode());
    resolveTypeNodeRefs(f.node.getReturnTypeNode());
  }

  // Resolve union param types: A | B → intersection of fields
  const typeDeclMap = new Map(typeDecls.map(d => [d.name, d]));
  for (const fn of functions) {
    for (const p of fn.params) {
      if (!p.tsType.includes(" | ")) continue;
      const arms = p.tsType.split(" | ").map(a => a.trim());
      const armDecls = arms.map(a => typeDeclMap.get(a)).filter((d): d is TypeDeclInfo => !!d && d.kind === "record");
      if (armDecls.length < 2 || armDecls.length !== arms.length) continue;
      // Compute field name intersection
      const fieldSets = armDecls.map(d => new Set(d.fields!.map(f => f.name)));
      const common = [...fieldSets[0]].filter(name => fieldSets.every(s => s.has(name)));
      // Find an existing type that matches, or use the first arm's fields
      const match = armDecls.find(d => d.fields!.length === common.length && d.fields!.every(f => common.includes(f.name)));
      if (match) {
        p.tsType = match.name;
      } else {
        // Generate synthetic union type with intersected fields
        const synName = arms.join("Or");
        if (!typeDeclMap.has(synName)) {
          const fields = common.map(name => {
            const f = armDecls[0].fields!.find(f => f.name === name)!;
            return { name: f.name, tsType: f.tsType };
          });
          typeDecls.push({ name: synName, kind: "record", fields });
          typeDeclMap.set(synName, typeDecls[typeDecls.length - 1]);
        }
        p.tsType = synName;
      }
    }
  }

  // In brownfield mode, filter consts to only those referenced by verified functions.
  if (hasVerifyDirective) {
    const referencedNames = new Set<string>();
    function collectNames(stmts: RawStmt[]) {
      for (const s of stmts) {
        if (s.kind === "let") { if (s.tsType) referencedNames.add(s.tsType); collectNamesExpr(s.init); }
        if (s.kind === "assign") { collectNamesExpr(s.value); }
        if (s.kind === "return") { collectNamesExpr(s.value); }
        if (s.kind === "if") { collectNamesExpr(s.cond); collectNames(s.then); collectNames(s.else); }
        if (s.kind === "while") { collectNamesExpr(s.cond); collectNames(s.body); }
        if (s.kind === "forof") { collectNamesExpr(s.iterable); collectNames(s.body); }
        if (s.kind === "expr") { collectNamesExpr(s.expr); }
      }
    }
    function collectNamesExpr(e: RawExpr) {
      if (e.kind === "var") referencedNames.add(e.name);
      if (e.kind === "binop") { collectNamesExpr(e.left); collectNamesExpr(e.right); }
      if (e.kind === "unop") { collectNamesExpr(e.expr); }
      if (e.kind === "call") { collectNamesExpr(e.fn); e.args.forEach(collectNamesExpr); }
      if (e.kind === "field") { collectNamesExpr(e.obj); }
      if (e.kind === "index") { collectNamesExpr(e.obj); collectNamesExpr(e.idx); }
      if (e.kind === "record") { if (e.spread) collectNamesExpr(e.spread); e.fields.forEach(f => collectNamesExpr(f.value)); }
      if (e.kind === "recordMerge") { collectNamesExpr(e.base); collectNamesExpr(e.override); }
      if (e.kind === "arrayLiteral") { e.elems.forEach(collectNamesExpr); }
      if (e.kind === "conditional") { collectNamesExpr(e.cond); collectNamesExpr(e.then); collectNamesExpr(e.else); }
      if (e.kind === "nullish") { collectNamesExpr(e.left); collectNamesExpr(e.right); }
      if (e.kind === "nonNull") { collectNamesExpr(e.expr); }
      if (e.kind === "optChain") { collectNamesExpr(e.obj); for (const c of e.chain) { if (c.kind === "call") c.args.forEach(collectNamesExpr); if (c.kind === "index") collectNamesExpr(c.idx); } }
      if (e.kind === "lambda") { if (Array.isArray(e.body)) collectNames(e.body); else collectNamesExpr(e.body); }
      if (e.kind === "forall" || e.kind === "exists") { collectNamesExpr(e.body); }
    }
    // Signature types (params + return) get base-name stripping below; body /
    // spec references stay exact-match (so a body `let xs: Hunk[]` doesn't pull
    // `Hunk` into the filter early and reorder output that resolveType re-adds).
    const sigTypes = new Set<string>();
    for (const fn of functions) {
      for (const p of fn.params) { referencedNames.add(p.tsType); sigTypes.add(p.tsType); }
      referencedNames.add(fn.returnType); sigTypes.add(fn.returnType);
      collectNames(fn.body);
      // Also scan spec annotations for identifier references
      for (const spec of [...fn.requires, ...fn.ensures]) {
        for (const m of spec.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
          referencedNames.add(m[1]);
        }
      }
    }
    // A constant's initializer can reference other constants
    // (`const ZERO_NINE = ZERO + nthDigit(-1)`). Close over those initializers
    // before filtering — mirroring the transitive type filter below — or a
    // constant reachable only from another constant is dropped and the backend
    // sees an undefined name.
    // Snapshot first: what the closure adds are VALUE references, and a value
    // and a type can share a name (`const Action = Schema.Literals(…)` next to
    // `type Action = Schema.Schema.Type<typeof Action>`). Keeping the constant
    // alive must not also drag in the unrelated type alias, so the type filter
    // below runs off the pre-closure set.
    const typeReferencedNames = new Set(referencedNames);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of constants) {
        if (!referencedNames.has(c.name)) continue;
        const before = referencedNames.size;
        collectNamesExpr(c.value);
        if (referencedNames.size !== before) grew = true;
      }
    }
    constants.splice(0, constants.length, ...constants.filter(c => referencedNames.has(c.name)));
    // Filter types to only those referenced by verified functions (transitive)
    const neededTypes = new Set<string>();
    function markType(name: string) {
      if (neededTypes.has(name)) return;
      const d = typeDecls.find(t => t.name === name);
      if (!d) return;
      neededTypes.add(name);
      for (const f of d.fields ?? [])
        for (const m of f.tsType.matchAll(/\b([A-Z]\w*)\b/g)) markType(m[1]);
      for (const v of d.variants ?? [])
        for (const f of v.fields)
          for (const m of f.tsType.matchAll(/\b([A-Z]\w*)\b/g)) markType(m[1]);
    }
    for (const name of typeReferencedNames) markType(name);
    // Signature types also mark their base after stripping array/optional
    // WRAPPERS (`Out[]`/`Msg | undefined` → `Out`/`Msg`), so a function returning
    // a local `Out[]` keeps `Out`. Wrappers only — never dig into generic args
    // (`Omit<FilePathOptions, …>` must not pull in the inner type).
    // `ReadonlyArray<Out>`, `Array<Out>` and `readonly Out[]` are the same array wrapper.
    for (const name of sigTypes) {
      let base = name.replace(/\s*\|\s*(undefined|null)\s*$/, "").trim();
      for (let prior = ""; prior !== base; ) {
        prior = base;
        base = base.replace(/^readonly\s+/, "").replace(/(\[\])+$/, "").replace(/^(?:Readonly)?Array<(.+)>$/, "$1").trim();
      }
      // Keep a local generic result declaration itself, without pulling in
      // any of its type arguments (Omit<X,...> still does not mark X).
      const outer = base.replace(/<.*>$/, "").trim();
      if (/^[A-Za-z_]\w*$/.test(outer)) markType(outer);
    }
    typeDecls.splice(0, typeDecls.length, ...typeDecls.filter(d => neededTypes.has(d.name) || declaredNames.has(d.name)));
  }

  // Resolve imported types: extract types referenced in function signatures but not in this file
  const knownTypes = new Set(typeDecls.map(d => d.name));
  const builtins = new Set(["Map", "Set", "Array", "String", "Number", "Boolean", "Promise", "Date", "RegExp", "Error"]);
  const visitedTypes = new Set<unknown>();
  function resolveType(t: Type, locationNode: Node) {
    // Resolve type aliases (e.g. string unions imported from other files).
    // BEFORE the visited guard: the same interned compilerType can arrive both
    // with and without its alias symbol (getTypeAtLocation drops it), and an
    // aliasless first visit must not suppress the alias extraction.
    const alias = t.getAliasSymbol();
    if (alias) {
      const aliasName = alias.getName();
      // A //@ declare-type already defines the verification surface for this
      // alias. Don't walk the imported structure — its union members would
      // leak unrelated variant datatypes (and the types those reference, which
      // we don't model) into the output. See examples/declareTypeShadow.ts.
      if (declaredNames.has(aliasName)) return;
      if (!knownTypes.has(aliasName) && !builtins.has(aliasName) && !aliasName.startsWith("__")) {
        const decls = alias.getDeclarations();
        if (decls.length > 0 && Node.isTypeAliasDeclaration(decls[0])) {
          const extra: TypeDeclInfo[] = [];
          const info = extractTypeDecl(decls[0], extra);
          if (info) { typeDecls.push(...extra); typeDecls.push(info); knownTypes.add(aliasName); }
        } else if (t.getProperties().length > 0) {
          // Alias declaration not available (e.g. intersection type) — extract from properties
          const extra: TypeDeclInfo[] = [];
          const info = extractRecord(aliasName, t, locationNode, undefined, extra);
          if (info) { typeDecls.push(...extra); typeDecls.push(info); knownTypes.add(aliasName); }
        }
      }
    }
    // Recursion guard: recursive unions (Expr → variant → body: Expr) are
    // reachable now that anonymous variant fields are walked below. Keyed on
    // the compiler's interned Type object — alias names are not enough,
    // because getTypeAtLocation can drop the alias symbol.
    if (visitedTypes.has(t.compilerType)) return;
    visitedTypes.add(t.compilerType);
    // Unwrap arrays and generics to find user-defined types
    if (t.isArray()) { resolveType(t.getArrayElementTypeOrThrow(), locationNode); return; }
    if (t.isUnion()) { for (const u of t.getUnionTypes()) resolveType(u, locationNode); return; }
    for (const arg of t.getTypeArguments()) resolveType(arg, locationNode);
    const sym = t.getSymbol() ?? t.getAliasSymbol();
    const name = sym?.getName();
    if (name && !name.startsWith("__") && !knownTypes.has(name) && !builtins.has(name) && (t.isObject() || t.isIntersection())) {
      const extra: TypeDeclInfo[] = [];
      // A generic interface is declared once over its own parameters, not over this use's type arguments.
      const declared = sym?.getDeclarations()[0];
      const info = declared && Node.isInterfaceDeclaration(declared) && declared.getTypeParameters().length > 0
        ? extractInterface(declared, extra)
        : extractRecord(name, t, locationNode, undefined, extra);
      if (info) {
        typeDecls.push(...extra); typeDecls.push(info); knownTypes.add(name);
        // Recursively resolve types referenced in this type's fields
        for (const prop of t.getProperties()) {
          resolveType(prop.getTypeAtLocation(locationNode), locationNode);
        }
      }
    } else if (t.isObject() && (!name || name.startsWith("__")) && t.getCallSignatures().length === 0) {
      // Anonymous object type — typically a variant of an imported
      // discriminated union. There is no decl to extract, but its fields can
      // reference named types (`arms: MatchArm[]`) that downstream passes
      // need declared, so walk them.
      for (const prop of t.getProperties()) {
        resolveType(prop.getTypeAtLocation(locationNode), locationNode);
      }
    }
  }
  for (let i = 0; i < fnsToExtract.length; i++) {
    const f = fnsToExtract[i];
    const fn = functions[i];
    // Skip params whose TS type was overridden by `//@ type <param> <Override>`
    // — the verification works against the override, so cross-file resolving
    // the original type pulls in unused datatypes (often with unsupported
    // shapes the override exists precisely to avoid).
    const overriddenNames = new Set(fn.typeAnnotations.map(a => a.name));
    for (const p of f.node.getParameters()) {
      if (overriddenNames.has(p.getName())) continue;
      resolveType(p.getType(), p);
    }
  }
  // Extern signature types: see _externSigTypes.
  for (const r of _externSigTypes) resolveType(r.type, r.node);
  // Resolve anonymous object return types into synthetic named types
  for (let i = 0; i < fnsToExtract.length; i++) {
    const f = fnsToExtract[i];
    const fn = functions[i];
    const retType = f.node.getReturnType();
    // Prefer alias symbol (named type aliases) over underlying object symbol (__type)
    const aliasSym = retType.getAliasSymbol();
    if (aliasSym && !aliasSym.getName().startsWith("__")) {
      const aliasName = aliasSym.getName();
      // If the alias name is already locally declared (e.g. via `//@ declare-type
      // Ruleset = Rule[]`), don't unwrap further — the declared shape is the
      // verification surface, and walking the original cross-file alias pulls
      // unused datatypes (often with unsupported shapes) into the gen.
      if (!knownTypes.has(aliasName)) {
        // Named type alias — resolve it instead of generating a synthetic name
        resolveType(retType, f.node);
      }
      if (knownTypes.has(aliasName)) {
        // Preserve type arguments: Result<Model, Err> not just Result
        const typeArgs = retType.getAliasTypeArguments();
        fn.returnType = typeArgs.length > 0
          ? `${aliasName}<${typeArgs.map(t => typeToString(t)).join(", ")}>`
          : aliasName;
      }
      continue;
    }
    // Inline-anon return type — bare `{...}` (no union wrapping).
    //
    // ts-morph's `fn.getReturnType()` returns the COMPUTED type, which strips
    // `| null` in non-strict mode (and sometimes `| undefined`). The source
    // annotation, however, encodes the user's actual intent. Check the
    // already-extracted `fn.returnType` string for nullish suffixes to detect
    // the wrap-in-Optional case.
    let innerType: Type | null = null;
    let wrapOptional = false;
    const sourceReturnText = fn.returnType ?? "";
    const sourceHadNullish = / \| (null|undefined)$/.test(sourceReturnText)
      || sourceReturnText.includes(" | null ") || sourceReturnText.includes(" | undefined ")
      || sourceReturnText.includes(" | null|") || sourceReturnText.includes(" | undefined|");
    const sym = retType.getSymbol();
    if (sym?.getName() === "__type" && retType.isObject() && !retType.isArray()) {
      innerType = retType;
      if (sourceHadNullish) wrapOptional = true;
    } else if (retType.isUnion()) {
      const arms = retType.getUnionTypes();
      const nullish = arms.filter(t => t.isNull() || t.isUndefined());
      const others = arms.filter(t => !t.isNull() && !t.isUndefined());
      if (nullish.length >= 1 && others.length === 1) {
        const onlyOther = others[0];
        const otherSym = onlyOther.getSymbol();
        if (otherSym?.getName() === "__type" && onlyOther.isObject() && !onlyOther.isArray()) {
          innerType = onlyOther;
          wrapOptional = true;
        }
      }
    }
    if (innerType) {
      // Try typeToString first — it resolves collapsed single-variant unions
      const resolved = typeToString(innerType);
      if (resolved !== "__type" && !resolved.includes("__type") && knownTypes.has(resolved)) {
        fn.returnType = wrapOptional ? `${resolved} | undefined` : resolved;
        continue;
      }
      const synName = fn.name.charAt(0).toUpperCase() + fn.name.slice(1) + "Result";
      if (!knownTypes.has(synName)) {
        const extra: TypeDeclInfo[] = [];
        const info = extractRecord(synName, innerType, f.node, undefined, extra);
        if (info) { typeDecls.push(...extra); typeDecls.push(info); knownTypes.add(synName); }
      }
      fn.returnType = wrapOptional ? `${synName} | undefined` : synName;
      // Also resolve imported types referenced in the return type's fields
      for (const prop of innerType.getProperties()) {
        resolveType(prop.getTypeAtLocation(f.node), f.node);
      }
    }
  }

  // Extract classes with //@ verify methods
  const classes: RawClass[] = [];
  for (const cls of sourceFile.getClasses()) {
    if (hasLeadingDirective(cls, "skip")) continue;
    const methods: RawFunction[] = [];
    for (const method of cls.getMethods()) {
      if (hasLeadingDirective(method, "skip")) continue;
      if (!method.getFullText().includes('//@ verify')) continue;
      methods.push(extractFunction(method as any));
    }
    if (methods.length === 0) continue;
    const fields: { name: string; tsType: string }[] = [];
    for (const prop of cls.getProperties()) {
      fields.push({ name: prop.getName(), tsType: typeToString(prop.getType()) });
    }
    classes.push({ name: cls.getName() ?? "Anonymous", fields, methods });
  }

  // Clear the synth-union accumulator so typeToString reverts to plain
  // union stringification outside of an extractModule call.
  _synthArrayUnions = null;

  // Constants that copied cross-file contracts name, known only once every body has registered its externs. A
  // constant this module already declares or imports is the same declaration; any other same-named one is refused.
  constants.unshift(...importedConstants(sourceFile, new Set(constants.map(c => c.name)), false, _externContractConsts));

  return {
    file: sourceFile.getFilePath(),
    typeDecls,
    externs: Array.from(_externs.values()),
    constants,
    functions,
    classes,
  };
}

// ── Main ─────────────────────────────────────────────────────

if (process.argv[1]?.match(/extract\.(ts|js)$/)) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: extract <file.ts>"); process.exit(1); }
  const proj = new Project({ compilerOptions: { strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"] } });
  const sourceFile = proj.addSourceFileAtPath(file);
  desugarMessageUnions(sourceFile);
  console.log(JSON.stringify(extractModule(sourceFile), null, 2));
}
