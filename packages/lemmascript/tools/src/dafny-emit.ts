/**
 * Dafny emitter — IR → Dafny text.
 */

import type { Expr, Stmt, Decl, Module, MatchPattern } from "./ir.js";
import { exactIntegerLiteral, usesName, usesNameInDecl, usesNameInStmts } from "./ir.js";
import type { Ty } from "./typedir.js";
import { freshName, freshNameWhere, userNames } from "./names.js";
import { renameFreeVar } from "./transform.js";
import { DEFAULT_OPTIONS, resolveOptions, type LscOptions } from "./config.js";

/** Appended to a function's name for the lemma that carries its `//@ ensures`. */
export const ENSURES_LEMMA_SUFFIX = "_ensures";

/** Fresh binder for a comprehension wrapping the given subexpressions: `base`
 *  verbatim unless one of them references it, then primed until free. A *local*
 *  check — a same-named name elsewhere in the module keeps the plain binder. */
function freshBinder(base: string, ...wrapped: Expr[]): string {
  return freshNameWhere(base, name => wrapped.some(w => usesName(w, name)));
}

/** Binder + body for lowering a single-return lambda to a comprehension whose
 *  receiver is emitted inside the binder's scope. TS scoping keeps the receiver
 *  outside the lambda, so a lambda param sharing a name with anything free in
 *  the receiver would capture it — e.g. `mk(n).some(n => …)` naively emitting
 *  `exists n :: n in mk(n) && …`. Alpha-rename the param out of the way (and
 *  its free uses in the body); the zero-param default must also dodge free
 *  names in the body. */
function comprehensionBinder(lam: Extract<Expr, { kind: "lambda" }>, value: Expr, receiver: Expr): { binder: string; body: Expr } {
  const rawName = lam.params[0]?.name;
  if (rawName === undefined) return { binder: escapeName(freshBinder("x", receiver, value)), body: value };
  if (!usesName(receiver, rawName)) return { binder: escapeName(rawName), body: value };
  const fresh = freshBinder(rawName, receiver, value);
  return { binder: escapeName(fresh), body: renameFreeVar(value, rawName, fresh) };
}

// ── Ty → Dafny type string ─────────────────────────────────

function tyToDafny(ty: Ty): string {
  switch (ty.kind) {
    case "nat": return "nat";
    case "int": return "int";
    case "real": return "real";
    case "bool": return "bool";
    case "string": return "string";
    case "void": return "()";
    case "array": return `seq<${tyToDafny(ty.elem)}>`;
    case "tuple": return `(${ty.elems.map(tyToDafny).join(", ")})`;
    case "map": return `map<${tyToDafny(ty.key)}, ${tyToDafny(ty.value)}>`;
    case "set": return `set<${tyToDafny(ty.elem)}>`;
    case "optional": { needPreamble("OptionType"); return `Option<${tyToDafny(ty.inner)}>`; }
    case "user": return escapeName(ty.name);
    case "fn": return `(${ty.params.map(tyToDafny).join(", ")}) -> ${tyToDafny(ty.result)}`;
    // Out-of-subset (`any`/`unknown`); opaque so real ops on it fail loudly
    // rather than silently verify as `int`. Mirrors the Lean backend's `_`.
    case "unknown": needPreamble("UnknownType"); return "Unknown";
  }
}

// ── Dafny keyword escaping ──────────────────────────────────

const DAFNY_KEYWORDS = new Set([
  "seq", "set", "map", "multiset", "iset", "imap",
  "var", "method", "function", "predicate", "lemma",
  "class", "trait", "module", "import", "export",
  "if", "then", "else", "while", "for", "in",
  "match", "case", "return", "break", "continue",
  "requires", "ensures", "invariant", "decreases",
  "forall", "exists", "old", "fresh", "allocated",
  "true", "false", "null", /*"this",*/ "new",
  "datatype", "type", "const", "ghost", "static",
  "reads", "modifies", "assert", "assume", "print",
  "by", "calc", "reveal",
  // Further reserved words (validated against the Dafny parser) that are also
  // legal TS identifiers. `this` stays excluded above — class methods emit it
  // directly. `then`/`else` already covered.
  "bool", "char", "int", "nat", "real", "string", "object", "array",
  "as", "is", "label", "modify", "expect", "yield", "yields", "returns",
  "unchanged", "witness", "constructor", "iterator", "abstract", "extends",
  "refines", "opened", "provides", "reveals", "include", "newtype",
  "codatatype", "nameonly", "twostate", "opaque", "replaceable", "colemma",
  "copredicate", "inductive",
]);

// The Dafny out-parameter name for the method currently being emitted. Default
// `res`, but bumped (e.g. `res'`) when the method's own scope uses `res` — set
// by methodHeader and reset per decl. `\result` in an ensures must use the
// *same* name, so escapeName routes it here.
let _resultName = "res";

// User-type names appearing as the type of a havoc anywhere in the module —
// populated per file by emitDafnyFile, read by the opaque-type case.
const _havocedTypeNames = new Set<string>();

/** Collect the user-type names of every havoc in a decl tree. */
function collectHavocedTypeNames(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectHavocedTypeNames(x, out);
    return;
  }
  if (v === null || typeof v !== "object") return;
  const n = v as { kind?: string; type?: Ty };
  if (n.kind === "havoc" && n.type?.kind === "user") out.add(n.type.name);
  for (const x of Object.values(v)) collectHavocedTypeNames(x, out);
}

// ── Dafny name allocation ──────────────────────────────────
//
// freshName (names.ts) freshens in the *raw TS* namespace — but that is not the
// namespace Dafny sees. Escaping maps `_x`→`i_x` and keyword `match`→`match_`,
// so two raw-distinct names can collapse *after* escaping: a raw-freshened temp
// `_t0'`→`i_t0'` colliding with a user `_t0` that escaped-and-primed to `i_t0'`.
// So Dafny hygiene is a second allocator, layered at emission: escape to a base,
// then freshen against the names already claimed in the Dafny namespace. User
// names are allocated up front (Dafny-safe ones kept exact); generated names are
// allocated on first sight and cached so a decl and its references agree. Reset
// per file. (The raw freshName layer stays — Lean has a different escaping story.)

function dafnyBaseName(name: string): string {
  if (DAFNY_KEYWORDS.has(name)) return `${name}_`;
  if (name.startsWith("_")) return `i${name}`;  // Dafny forbids leading `_`
  return name;
}

let _userDafnyNames = new Map<string, string>();
let _generatedDafnyNames = new Map<string, string>();
let _takenDafnyNames = new Set<string>();

/** `base`, primed until free in the Dafny namespace. A prime can't occur in a
 *  TS identifier, so priming always leaves user-name space. */
function freshDafnyName(base: string): string {
  let out = base;
  while (_takenDafnyNames.has(out)) out += "'";
  return out;
}

function resetDafnyNameCache(): void {
  _userDafnyNames = new Map();
  _generatedDafnyNames = new Map();
  _takenDafnyNames = new Set();
  const raws = [...userNames()].sort();
  // Dafny-safe source names keep their spelling; names that must mangle are then
  // freshened in the emitted namespace (safe-first, sorted → deterministic).
  for (const raw of raws) if (dafnyBaseName(raw) === raw) { _userDafnyNames.set(raw, raw); _takenDafnyNames.add(raw); }
  for (const raw of raws) if (dafnyBaseName(raw) !== raw) {
    const emitted = freshDafnyName(dafnyBaseName(raw));
    _userDafnyNames.set(raw, emitted);
    _takenDafnyNames.add(emitted);
  }
}

/** Source-name → emitted-Dafny-name pairs from the most recent emitDafnyFile
 *  call (identity-mapped names included). Consumed by `lsc info --typed` so
 *  satellites (e.g. lemmascript-crosscheck) can address emitted declarations
 *  by their mangled names (`_Box` → `i_Box'`) without re-deriving the rules. */
export function emittedNameMap(): Map<string, string> {
  return new Map([..._generatedDafnyNames, ..._userDafnyNames]);
}

function escapeName(name: string): string {
  // \result is carried through the IR as var "\\result"; render it as the
  // current method's out-parameter name (chosen locally by methodHeader).
  if (name === "\\result") return _resultName;
  const user = _userDafnyNames.get(name);
  if (user !== undefined) return user;
  return escapeGeneratedName(name);
}

function isEmittedUserName(name: string): boolean {
  for (const emitted of _userDafnyNames.values()) {
    if (emitted === name) return true;
  }
  return false;
}

/** Allocate a toolchain-generated name (an ANF temp, a comprehension binder, a
 *  companion `_ensures` lemma). Escapes to a base, then freshens in the Dafny
 *  namespace so it can't collapse onto an escaped user name. Bypasses the user
 *  map on purpose: the raw name is synthesized, so it must be freshened *away
 *  from* a same-spelled user name, not aliased onto it. Cached so a declaration
 *  and its references render identically. */
function escapeGeneratedName(name: string): string {
  const cached = _generatedDafnyNames.get(name);
  if (cached !== undefined) return cached;
  const emitted = freshDafnyName(dafnyBaseName(name));
  _generatedDafnyNames.set(name, emitted);
  _takenDafnyNames.add(emitted);
  return emitted;
}

/** Format a typed parameter list for Dafny: "x: int, y: seq<int>" */
function paramList(params: { name: string; type: Ty }[]): string {
  return params.map(p => `${escapeName(p.name)}: ${tyToDafny(p.type)}`).join(", ");
}

/** Format a method signature header, normally omitting `returns` for void
 *  methods. A body-less impure extern opts into a Unit out-parameter so the
 *  shared method-call lifting can bind its call like any other expression. */
function methodHeader(prefix: string, params: { name: string; type: Ty }[], returnType: Ty,
                      scope?: { requires: Expr[]; ensures: Expr[]; body: Stmt[] },
                      includeVoidReturn = false): string {
  const sig = `${prefix}(${paramList(params)})`;
  if (returnType.kind === "void" && !includeVoidReturn) return sig;
  // The out-parameter is `res` by default, but a param (an Express handler's
  // `(req, res)`), body local, or callee named `res` would shadow it. Check only
  // *this method's own* signature and body — `res` is common module-wide (fields,
  // unrelated params), so a module-wide check would prime spuriously. The primed
  // name is recorded so `\result` references resolve to it.
  const taken = (n: string): boolean =>
    params.some(p => escapeName(p.name) === n) ||
    (scope !== undefined && usesNameInDecl(scope.requires, scope.ensures, scope.body, n));
  const resName = freshNameWhere("res", taken);
  _resultName = resName;
  return `${sig} returns (${resName}: ${tyToDafny(returnType)})`;
}

// ── Lean op → Dafny op ─────────────────────────────────────

const OP_MAP: Record<string, string> = {
  "=": "==", "≠": "!=", "≥": ">=", "≤": "<=",
  "∧": "&&", "∨": "||", "¬": "!", "↔": "<==>",
  "arrayConcat": "+",
};

/** Render a JavaScript string without losing its UTF-16 representation.
 *
 * JavaScript iteration by index exposes UTF-16 code units, including unpaired
 * surrogates. Node's UTF-8 file writer would replace an unpaired surrogate if
 * we emitted it literally, so every non-printable/non-ASCII unit is written as
 * a Dafny `\\uXXXX` escape. Under `--unicode-char:false`, each escape denotes
 * exactly one Dafny char and therefore exactly one JavaScript code unit.
 */
function escapeDafnyUTF16String(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += "\\\\";
    else if (0x20 <= unit && unit <= 0x7e) out += String.fromCharCode(unit);
    else out += `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

function mapOp(op: string): string { return OP_MAP[op] ?? op; }

// ── Expression emission ─────────────────────────────────────

function emitScrutinee(s: Expr): string {
  return emitExpr(s);
}

/** Collapse nested forall/exists into a single quantifier with multiple bound vars. */
function emitQuantifier(e: Expr & { kind: "forall" | "exists" }, keyword: string): string {
  const vars: string[] = [];
  let body: Expr = e;
  while (body.kind === e.kind) {
    const dty = tyToDafny((body as typeof e).type);
    const ann = dty === "string" ? "" : `: ${dty}`;
    vars.push(`${escapeName((body as typeof e).var)}${ann}`);
    body = (body as typeof e).body;
  }
  return `${keyword} ${vars.join(", ")} :: ${emitExpr(body)}`;
}

// Dafny's `forall`/`exists ::` body extends as far as possible. So
// `(forall i :: P(i)) <op> Q` (or `... ==> Q`) would parse with the operator
// absorbed into the body. Wrap a quantifier in parens to terminate its body
// before the operator. Only the LEFT operand needs this — a quantifier in
// right-operand position is fine because its body correctly spans the rest.
function wrapQuantifier(sub: Expr): string {
  const inner = emitExpr(sub);
  return (sub.kind === "forall" || sub.kind === "exists") ? `(${inner})` : inner;
}

function emitExpr(e: Expr): string {
  switch (e.kind) {
    case "var": return e.name === "undefined" ? "None" : escapeName(e.name);
    case "num": return `${e.value}`;
    // Already canonical decimal; Dafny's `int` is mathematical, so no `n` suffix.
    case "bigint": return e.value;
    case "bool": return e.value ? "true" : "false";
    case "str":
      // Under the default profile the literal is written exactly as before;
      // only the UTF-16 profile needs code-unit escapes (DESIGN_STRINGS.md §3).
      return isUtf16()
        ? `"${escapeDafnyUTF16String(e.value)}"`
        : `"${e.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

    case "constructor": {
      // Option constructors (Some/None) may appear in inferred positions
      // (e.g. lambda result) without an explicit `optional<T>` in any
      // signature, so request the preamble here.
      if (e.type === "Option") needPreamble("OptionType");
      const head = qualifyCtor(e.name, e.type);
      if (!e.args || e.args.length === 0) return head;
      return `${head}(${e.args.map(emitExpr).join(", ")})`;
    }

    case "arrayLiteral":
      if (e.elems.length === 0) return `[]`;
      return `[${e.elems.map(emitExpr).join(", ")}]`;

    case "tupleLiteral": return `(${e.elems.map(emitExpr).join(", ")})`;
    case "tupleProj": return `${emitExpr(e.obj)}.${e.index}`;

    case "emptyMap": return `map[]`;
    case "emptySet": return `{}`;

    case "mapLiteral": {
      const entries = e.entries.map(en => `${emitExpr(en.key)} := ${emitExpr(en.value)}`);
      return `map[${entries.join(", ")}]`;
    }

    case "methodCall": {
      const obj = emitExpr(e.obj);
      const args = e.args.map(emitExpr);
      const ty = e.objTy.kind;
      // Array methods
      if (ty === "array") {
        if (e.method === "with")     return `${obj}[${args[0]} := ${args[1]}]`;
        if (e.method === "includes") return args.length > 1 ? `(${args[0]} in ${obj}[${args[1]}..])` : `(${args[0]} in ${obj})`;
        if (e.method === "indexOf") { needPreamble("SeqIndexOf"); return args.length > 1 ? `SeqIndexOfFrom(${obj}, ${args[0]}, ${args[1]})` : `SeqIndexOf(${obj}, ${args[0]})`; }
        if (e.method === "push")     return `(${obj} + [${args.join(", ")}])`;
        if (e.method === "unshift")  return `([${args.join(", ")}] + ${obj})`;
        if (e.method === "concat")   return `(${obj} + [${args.join(", ")}])`;
        if (e.method === "sort")     {
          if (args.length === 0) { needPreamble("SeqSort"); return `SeqSort(${obj})`; }
          needPreamble("SeqSortBy"); return `SeqSortBy(${obj}, ${args[0]})`;
        }
        // No-arg slice is a full copy; Dafny seq is an immutable value type, so
        // the copy is just the seq itself (the idiom for "copy then mutate").
        if (e.method === "slice" && args.length === 0) return obj;
        if (e.method === "slice" && args.length === 1) return `${obj}[${args[0]}..]`;
        if (e.method === "slice" && args.length === 2) {
          // JS slice clamps both bounds; Dafny requires `0 <= lo <= hi <= |s|`.
          // Direct slice is default (matches existing case studies that wrote
          // bounded calls). Files needing JS clamping opt in via `//@ safe-slice`.
          if (_useSafeSlice) {
            needPreamble("SafeSlice");
            return `SafeSlice(${obj}, ${args[0]}, ${args[1]})`;
          }
          return `${obj}[${args[0]}..${args[1]}]`;
        }
        if (e.method === "map") {
          // Always a seq comprehension: Seq.Map would hide the element access
          // behind a closure, defeating Dafny's termination checker for
          // recursive rebuild walkers. A literal lambda argument is
          // beta-reduced through a `var` binding — an applied closure defeats
          // the checker too; any other argument is applied to the element
          // directly. A non-variable receiver is bound once up front: the
          // comprehension mentions it three times, and splicing would make
          // any closure literal inside it (e.g. a Filter predicate) three
          // distinct closures, unprovably equal through an opaque callee.
          // Name freshness is a local IR-level check until a backend name
          // allocator exists.
          const lam = e.args[0];
          const fresh = (base: string, taken: (n: string) => boolean): string => {
            let name = base;
            for (let n = 2; taken(name); n++) name = `${base}${n}`;
            return name;
          };
          const taken = (n: string): boolean =>
            usesName(e.obj, n) || usesName(lam, n) ||
            (lam.kind === "lambda" && (lam.params.some(pp => pp.name === n) ||
              usesNameInStmts(lam.body, n)));
          const bind = e.obj.kind !== "var";
          const s = bind ? fresh("s_map", taken) : obj;
          const idx = fresh("i_map", n => taken(n) || n === s);
          let core: string;
          if (lam.kind === "lambda" && lam.params.length === 1 &&
              lam.body.length === 1 && lam.body[0].kind === "return") {
            const p = escapeName(lam.params[0].name);
            core = `var ${p} := ${s}[${idx}]; ${emitExpr(lam.body[0].value)}`;
          } else {
            core = `(${args[0]})(${s}[${idx}])`;
          }
          const comp = `seq(|${s}|, ${idx} requires 0 <= ${idx} < |${s}| => ${core})`;
          return bind ? `(var ${s} := ${obj}; ${comp})` : comp;
        }
        if (e.method === "filter") {
          if (_dafnyLibrary === "stdlib") return `Std.Collections.Seq.Filter(${args[0]}, ${obj})`;
          needPreamble("SeqFilter");
          return `SeqFilter(${args[0]}, ${obj})`;
        }
        // filterMap (synthesized in resolve): drop Nones and unwrap to seq<T>.
        if (e.method === "filterSome") { needPreamble("SeqFilterSome"); needPreamble("OptionType"); return `SeqFilterSome(${obj})`; }
        if (e.method === "every") {
          if (_dafnyLibrary === "stdlib") return `Std.Collections.Seq.All(${obj}, ${args[0]})`;
          needPreamble("SeqAll");
          return `SeqAll(${obj}, ${args[0]})`;
        }
        if (e.method === "find") {
          needPreamble("OptionType");
          needPreamble("SeqFind");
          return `SeqFind(${obj}, ${args[0]})`;
        }
        if (e.method === "findLast") {
          needPreamble("OptionType");
          needPreamble("SeqFindLast");
          return `SeqFindLast(${obj}, ${args[0]})`;
        }
        if (e.method === "findIndex") {
          needPreamble("SeqFindIndex");
          return `SeqFindIndex(${obj}, ${args[0]})`;
        }
        if (e.method === "findLastIndex") {
          needPreamble("SeqFindLastIndex");
          return `SeqFindLastIndex(${obj}, ${args[0]})`;
        }
        if (e.method === "flat" && args.length === 0) {
          needPreamble("SeqFlatten");
          return `SeqFlatten(${obj})`;
        }
        if (e.method === "join") {
          needPreamble("SeqJoin");
          return `SeqJoin(${obj}, ${args[0]})`;
        }
        // `.some(pred)`: inline a single-return lambda's body, else apply the
        // predicate (e.g. a function reference).
        if (e.method === "some") {
          const lam = e.args[0];
          let p: string, body: string;
          if (lam.kind === "lambda" && lam.body.length === 1 && lam.body[0].kind === "return") {
            const cb = comprehensionBinder(lam, lam.body[0].value, e.obj);
            p = cb.binder;
            body = emitExpr(cb.body);
          } else {
            p = escapeName(freshBinder("x", e.obj, e.args[0]));
            body = `${args[0]}(${p})`;
          }
          return `(exists ${p} :: ${p} in ${obj} && ${body})`;
        }
        // `.reduce(f, init)` → FoldLeft(f, init, xs), using the selected library.
        if (e.method === "reduce" && args.length === 2) {
          if (_dafnyLibrary === "stdlib") return `Std.Collections.Seq.FoldLeft(${args[0]}, ${args[1]}, ${obj})`;
          needPreamble("SeqFoldLeft");
          return `SeqFoldLeft(${args[0]}, ${args[1]}, ${obj})`;
        }
      }
      // String methods
      if (ty === "string") {
        if (e.method === "indexOf") {
          needPreamble("StringIndexOf");
          if (args.length === 2) {
            needPreamble("StringSearchPosition");
            return `StringIndexOfFrom(${obj}, ${args[0]}, StringSearchPosition(${obj}, ${args[1]}))`;
          }
          return `StringIndexOf(${obj}, ${args[0]})`;
        }
        if (e.method === "split")   { needPreamble("StringSplit"); return `StringSplit(${obj}, ${args[0]})`; }
        if (e.method === "slice") {
          // JS negative index: arr.slice(0, -N) → arr[0..|arr|-N]. Transform
          // folds unary minus on a numeric literal into a negative `num` node,
          // but leaves a negated bigint structural — `exactIntegerLiteral`
          // recognizes both.
          const negVal = (a: typeof e.args[0]): string | null => {
            const v = exactIntegerLiteral(a);
            return v !== null && v < 0n ? (-v).toString(10) : null;
          };
          const loN = negVal(e.args[0]);
          const loEx = loN !== null ? `|${obj}|-${loN}` : args[0];
          if (args.length === 1) return `${obj}[${loEx}..]`;
          const hiN = negVal(e.args[1]);
          const hiEx = hiN !== null ? `|${obj}|-${hiN}` : args[1];
          return `${obj}[${loEx}..${hiEx}]`;
        }
        if (e.method === "substring") {
          if (args.length === 1) return `${obj}[${args[0]}..]`;
          return `${obj}[${args[0]}..${args[1]}]`;
        }
        if (e.method === "endsWith") {
          if (args.length === 2) {
            needPreamble("StringSearchPosition");
            needPreamble("StringEndsWithAt");
            return `StringEndsWithAt(${obj}, ${args[0]}, ${args[1]})`;
          }
          return `(|${obj}| >= |${args[0]}| && ${obj}[|${obj}|-|${args[0]}|..] == ${args[0]})`;
        }
        if (e.method === "trim")    { needPreamble("StringTrim"); return `StringTrim(${obj})`; }
        if (e.method === "trimEnd") { needPreamble("StringTrim"); return `StringTrimRight(${obj})`; }
        if (e.method === "trimStart") { needPreamble("StringTrim"); return `StringTrimLeft(${obj})`; }
        if (e.method === "toLowerCase") { needPreamble("StringToLower"); return `StringToLower(${obj})`; }
        if (e.method === "toUpperCase") { needPreamble("StringToUpper"); return `StringToUpper(${obj})`; }
        if (e.method === "includes") {
          needPreamble("StringIndexOf");
          if (args.length === 2) {
            needPreamble("StringSearchPosition");
            return `(StringIndexOfFrom(${obj}, ${args[0]}, StringSearchPosition(${obj}, ${args[1]})) >= 0)`;
          }
          return `(StringIndexOf(${obj}, ${args[0]}) >= 0)`;
        }
        if (e.method === "startsWith") {
          if (args.length === 2) {
            needPreamble("StringSearchPosition");
            needPreamble("StringStartsWithAt");
            return `StringStartsWithAt(${obj}, ${args[0]}, ${args[1]})`;
          }
          return `(|${obj}| >= |${args[0]}| && ${obj}[..|${args[0]}|] == ${args[0]})`;
        }
        if (e.method === "charCodeAt") return `(${obj}[${args[0]}] as int)`;
        if (e.method === "repeat") { needPreamble("StringRepeat"); return `StringRepeat(${obj}, ${args[0]})`; }
      }
      // Map methods
      if (ty === "map") {
        if (e.method === "getDirect") return `${obj}[${args[0]}]`;
        if (e.method === "get") {
          needPreamble("OptionType");
          return `(if ${args[0]} in ${obj} then Some(${obj}[${args[0]}]) else None)`;
        }
        if (e.method === "set") return `${obj}[${args[0]} := ${args[1]}]`;
        if (e.method === "has") return `(${args[0]} in ${obj})`;
        if (e.method === "delete") {
          // Minted comprehension binder: freshen so a user variable `k` in the
          // receiver or key isn't captured (`k != k` would delete nothing).
          // Local check — only this comprehension's own operands can collide.
          const k = escapeName(freshBinder("k", e.obj, e.args[0]));
          return `(map ${k} | ${k} in ${obj} && ${k} != ${args[0]} :: ${obj}[${k}])`;
        }
      }
      // Set methods
      if (ty === "set") {
        if (e.method === "has") return `(${args[0]} in ${obj})`;
        if (e.method === "add") return `(${obj} + {${args[0]}})`;
        if (e.method === "delete") return `(${obj} - {${args[0]}})`;
        // `.filter(pred)` on a set: extract collapses the JS idiom
        // `new Set([...s].filter(p))` into `s.filter(p)` with set receiver
        // (the spread → array → set round-trip is identity over set
        // semantics). Lower to Dafny set-builder: `set x | x in s && p(x)`.
        if (e.method === "filter" && e.args.length === 1 && e.args[0].kind === "lambda" &&
            e.args[0].body.length === 1 && e.args[0].body[0].kind === "return") {
          const lam = e.args[0];
          const ret = lam.body[0];
          if (ret.kind !== "return") throw new Error("unreachable");
          const { binder: p, body: v } = comprehensionBinder(lam, ret.value, e.obj);
          const body = emitExpr(v);
          return `(set ${p} | ${p} in ${obj} && ${body})`;
        }
      }
      throw new Error(`Unsupported Dafny method call: .${e.method}() on ${ty}`);
    }

    case "lambda": {
      const ps = paramList(e.params);
      if (e.body.length === 1 && e.body[0].kind === "return")
        return `(${ps}) => ${emitExpr(e.body[0].value)}`;
      throw new Error("Unsupported: multi-statement lambda in Dafny");
    }

    case "unop": {
      const op = mapOp(e.op);
      if (op === "!" && e.expr.kind !== "var" && e.expr.kind !== "bool")
        return `!(${emitExpr(e.expr)})`;
      if (e.op === "-" && e.expr.kind === "num") return `(-(${e.expr.value}))`;
      if (e.op === "-" && e.expr.kind === "bigint") return `(-(${e.expr.value}))`;
      if (e.op === "-") return `(-(${emitExpr(e.expr)}))`;
      return `${op}(${emitExpr(e.expr)})`;
    }

    case "binop": {
      // Discriminant check: x == .Ctor → x.Ctor?
      const op = mapOp(e.op);
      if ((op === "==" || op === "!=") && e.right.kind === "constructor") {
        const ctorName = dafnyCtorName(e.right.name.replace(/^\./, ""));
        const pred = `${emitExpr(e.left)}.${ctorName}?`;
        return op === "!=" ? `(!${pred})` : pred;
      }
      // Bitwise operators on int: translate to arithmetic
      // x >> n → x / 2^n (right shift)
      // x << n → x * 2^n (left shift)
      if (e.op === ">>" || e.op === "<<") {
        const shift = exactIntegerLiteral(e.right);
        // Cap the fold: a huge literal shift would inline an absurd numeral.
        if (shift !== null && shift >= 0n && shift <= 1024n) {
          const factor = (1n << shift).toString(10);
          return `(${emitExpr(e.left)} ${e.op === ">>" ? "/" : "*"} ${factor})`;
        }
        needPreamble("Pow2");
        return `(${emitExpr(e.left)} ${e.op === ">>" ? "/" : "*"} Pow2(${emitExpr(e.right)}))`;
      }
      // x & mask → x % (mask + 1) for literal masks of form 2^n - 1, else BitAnd
      if (e.op === "&") {
        const mask = exactIntegerLiteral(e.right);
        if (mask !== null && mask >= 0n) {
          const modulus = mask + 1n;
          if ((modulus & (modulus - 1n)) === 0n) {
            return `(${emitExpr(e.left)} % ${modulus.toString(10)})`;
          }
        }
        needPreamble("BitAnd");
        return `BitAnd(${emitExpr(e.left)}, ${emitExpr(e.right)})`;
      }
      // x | y → BitOr(x, y) (recursive, mirrors BitAnd). Dafny has no `|` on int,
      // only on bitvectors.
      if (e.op === "|") {
        needPreamble("BitOr");
        return `BitOr(${emitExpr(e.left)}, ${emitExpr(e.right)})`;
      }
      // int→real coercion is now injected upstream in transform (toReal nodes),
      // which has full type information — including real-typed variables, not
      // just literals — so no literal-based coercion is needed here.
      return `(${wrapQuantifier(e.left)} ${op} ${emitExpr(e.right)})`;
    }

    case "implies": {
      const parts = [...e.premises.map(wrapQuantifier), emitExpr(e.conclusion)];
      return `(${parts.join(" ==> ")})`;
    }

    case "app": {
      const args = e.args.map(emitExpr);
      if (e.fn === "SetToSeq") { needPreamble("SetToSeq"); return `SetToSeq(${args.join(", ")})`; }
      if (e.fn === "BigInt" || e.fn === "Number") return args[0]; // identity: both map to int
      // Set literal: {a, b, c}
      if (e.fn === "SetLiteral") return `{${args.join(", ")}}`;
      if (e.fn === "JSFloorDiv") needPreamble("JSFloorDiv");
      if (e.fn === "JSRem") needPreamble("JSRem");
      if (e.fn === "JSTruncDiv") needPreamble("JSTruncDiv");
      if (e.fn === "JSStringLt") needPreamble("JSStringLt");
      if (e.fn === "CeilReal") needPreamble("CeilReal");
      if (e.fn === "FloorReal") needPreamble("FloorReal");
      if (e.fn === "StringFromCharCode") needPreamble("StringFromCharCode");
      if (e.fn === "NatToString") needPreamble("NatToString");
      if (e.fn === "IntToString") { needPreamble("NatToString"); needPreamble("IntToString"); }
      if (e.fn === "MathAbs") needPreamble("MathAbs");
      if (e.fn === "MathMin") needPreamble("MathMin");
      if (e.fn === "MathMax") needPreamble("MathMax");
      if (e.fn === "MaxOfSeq") { needPreamble("MathMax"); needPreamble("MaxOfSeq"); }
      if (e.fn === "MinOfSeq") { needPreamble("MathMin"); needPreamble("MinOfSeq"); }
      if (e.fn === "Perm") needPreamble("Perm");
      if (e.fn === "SetFromSeq") needPreamble("SetFromSeq");
      // A constructor application must spell the name the same way the
      // datatype declaration does — `dafnyCtorName`, not `escapeName`, since
      // tags come from source strings ("spec-pure") that escapeName leaves alone.
      if (e.ctorOf) {
        const ctor = dafnyCtorName(e.fn);
        // A source local may have the same name as a discriminated-union
        // variant (`const error = ...; return { kind: "error", error }`).
        // The bare `error(error)` is then parsed as a call through the local.
        // Qualify whenever the emitted constructor spelling is already claimed
        // in the user namespace, as well as when two datatypes share it.
        return _ambiguousCtors.has(e.fn) || isEmittedUserName(ctor)
          ? `${e.ctorOf}.${ctor}(${args.join(", ")})`
          : `${ctor}(${args.join(", ")})`;
      }
      return `${escapeName(e.fn)}(${args.join(", ")})`;
    }

    case "field": {
      const obj = emitExpr(e.obj);
      // `size`/`length`/`keys` are collection intrinsics unless the transform
      // proved this is a declared datatype field (then project it).
      if (!e.datatypeField && (e.field === "size" || e.field === "length" || e.field === "collectionSize")) return `|${obj}|`;
      if (!e.datatypeField && e.field === "keys") return `${obj}.Keys`;
      if (e.field === "toNat") return obj;
      if (e.ctor && e.fromUnion) {
        const renamed = _ctorFieldRenames.get(`${e.fromUnion}.${e.ctor}.${e.field}`);
        if (renamed) return `${obj}.${escapeName(renamed)}`;
      }
      return `${obj}.${escapeName(e.field)}`;
    }

    case "toNat":
      // Dafny doesn't need toNat — just emit the inner expression
      return emitExpr(e.expr);

    case "toReal":
      return `(${emitExpr(e.expr)} as real)`;

    case "index": {
      const obj = emitExpr(e.arr);
      const idx = emitExpr(e.idx);
      // Plain seq/map subscript. For maps where the result is meant to be
      // `Option<V>` (the TS `Record<K,V>[k]` shape), transform should have
      // wrapped this in an Option-coercion; here we just emit the subscript.
      return `${obj}[${idx}]`;
    }

    case "record": {
      if (e.spread) {
        if (e.fields.length === 0) {
          return emitExpr(e.spread);
        }
        const updates = e.fields.map(f => {
          const renamed = e.ctor && e.ctorOf ? _ctorFieldRenames.get(`${e.ctorOf}.${e.ctor}.${f.name}`) : undefined;
          return `${escapeName(renamed ?? f.name)} := ${emitExpr(f.value)}`;
        });
        return `${emitExpr(e.spread)}.(${updates.join(", ")})`;
      }
      // Match constructor by field names — prefer exact match over first-field heuristic
      let ctorName: string | undefined;
      if (e.fields.length > 0) {
        const fieldNames = new Set(e.fields.map(f => f.name));
        const matches: string[] = [];
        for (const [name, fields] of _structureDecls) {
          if (fields.length >= e.fields.length && fields.every(f => fieldNames.has(f.name) || f.type.kind === "optional")) {
            matches.push(name);
          }
        }
        // When several datatypes share this field-name set (e.g. Event vs
        // SparseEvent), disambiguate by the resolved record type carried from
        // transform; otherwise take the sole structural match.
        if (e.ctor && matches.includes(e.ctor)) ctorName = e.ctor;
        else if (matches.length > 0) ctorName = matches[0];
        if (!ctorName) ctorName = _recordCtors.get(e.fields[0].name);
      }
      if (ctorName) {
        const structFields = _structureDecls.get(ctorName);
        // Always reorder by struct field name — TS object literal order ≠ Dafny
        // positional order. Pad missing optional fields with None.
        if (structFields) {
          const provided = new Map(e.fields.map(f => [f.name, f]));
          const vals = structFields.map(sf => {
            const f = provided.get(sf.name);
            if (f) return emitExpr(f.value);
            if (sf.type.kind === "optional") { needPreamble("OptionType"); return "None"; }
            return `/* missing: ${sf.name} */`;
          });
          return `${ctorName}(${vals.join(", ")})`;
        }
        const vals = e.fields.map(f => emitExpr(f.value));
        return `${ctorName}(${vals.join(", ")})`;
      }
      if (e.fields.length === 0) return `map[]`;
      const vals = e.fields.map(f => emitExpr(f.value));
      return `(${vals.join(", ")})`;
    }

    case "if":
      return `(if ${emitExpr(e.cond)} then ${emitExpr(e.then)} else ${emitExpr(e.else)})`;

    case "match": {
      const scrut = emitScrutinee(e.scrutinee);
      const arms = e.arms.map(a => `case ${translatePattern(a.pattern)} => ${emitExpr(a.body)}`);
      return `(match ${scrut} { ${arms.join(" ")} })`;
    }

    case "forall": return emitQuantifier(e, "forall");
    case "exists": return emitQuantifier(e, "exists");

    case "let": return `(var ${escapeName(e.name)} := ${emitExpr(e.value)}; ${emitExpr(e.body)})`;
    case "havoc": return "*";
    // No Dafny producer: the only `default` source is the Lean return-in-loop
    // rewrite, which never runs on the Dafny path (native in-loop returns).
    case "default": throw new Error("default-value expression not produced on the Dafny path");
  }
}

/** Emit a pure expression with indentation for if/match/let. */
function emitPureExpr(e: Expr, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (e.kind) {
    case "if":
      return `${pad}if ${emitExpr(e.cond)} then\n${emitPureExpr(e.then, indent + 1)}\n${pad}else\n${emitPureExpr(e.else, indent + 1)}`;
    case "match": {
      const scrut = emitScrutinee(e.scrutinee);
      const lines = [`${pad}match ${scrut} {`];
      for (const arm of e.arms) {
        lines.push(`${pad}  case ${translatePattern(arm.pattern)} =>`);
        lines.push(emitPureExpr(arm.body, indent + 2));
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "let":
      return `${pad}var ${escapeName(e.name)} := ${emitExpr(e.value)};\n${emitPureExpr(e.body, indent)}`;
    default:
      return `${pad}${emitExpr(e)}`;
  }
}

// ── Statement emission ──────────────────────────────────────

function emitStmts(stmts: Stmt[], indent: number): string {
  return stmts.map(s => emitStmt(s, indent)).join("\n");
}

function emitStmt(s: Stmt, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (s.kind) {
    case "let":
      // Record literal assigned to map type → emit as map[k := v, ...]
      if (s.type.kind === "map" && s.value.kind === "record" && !s.value.spread) {
        const entries = s.value.fields.map(f => `${emitExpr({ kind: "str", value: f.name })} := ${emitExpr(f.value)}`);
        return `${pad}var ${escapeName(s.name)}: ${tyToDafny(resolveTy(s.type))} := map[${entries.join(", ")}];`;
      }
      if (s.value.kind === "havoc" || s.value.kind === "emptyMap" || s.value.kind === "emptySet" ||
          (s.value.kind === "arrayLiteral" && s.value.elems.length === 0))
        return `${pad}var ${escapeName(s.name)}: ${tyToDafny(s.type)} := ${emitExpr(s.value)};`;
      return `${pad}var ${escapeName(s.name)} := ${emitExpr(s.value)};`;
    case "assign":
      // Transform.ts lowers a bare expression statement to an assign with target _
      // so special case this to Dafny's anonymous binding.
      if (s.target === "_") return `${pad}var _ := ${emitExpr(s.value)};`;
      return `${pad}${escapeName(s.target)} := ${emitExpr(s.value)};`;
    case "ghostLet":
      return `${pad}ghost var ${escapeName(s.name)}: ${tyToDafny(s.type)} := ${emitExpr(s.value)};`;
    case "ghostAssign":
      return `${pad}${escapeName(s.target)} := ${emitExpr(s.value)};`;
    case "assert":
      return `${pad}${s.assumed ? "assume {:axiom}" : "assert"} ${emitExpr(s.expr)};`;
    case "bind":
      // Monadic bind shouldn't appear in Dafny mode, emit as regular assign
      return `${pad}${escapeName(s.target)} := ${emitExpr(s.value)};`;
    case "let-bind":
      // Monadic let-bind shouldn't appear in Dafny mode, emit as regular let
      return `${pad}var ${escapeName(s.name)} := ${emitExpr(s.value)};`;
    case "return":
      return `${pad}return ${emitExpr(s.value)};`;
    case "break":
      return `${pad}break;`;
    case "continue":
      return `${pad}continue;`;

    case "if": {
      let out = `${pad}if ${emitExpr(s.cond)} {\n${emitStmts(s.then, indent + 1)}\n${pad}}`;
      if (s.else.length > 0) {
        if (s.else.length === 1 && s.else[0].kind === "if") {
          out += ` else ${emitStmt(s.else[0], indent).trimStart()}`;
        } else {
          out += ` else {\n${emitStmts(s.else, indent + 1)}\n${pad}}`;
        }
      }
      return out;
    }

    case "match": {
      const scrut = emitScrutinee(s.scrutinee);
      const lines = [`${pad}match ${scrut} {`];
      for (const arm of s.arms) {
        lines.push(`${pad}  case ${translatePattern(arm.pattern)} =>`);
        lines.push(emitStmts(arm.body, indent + 2));
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }

    case "while": {
      const lines = [`${pad}while ${emitExpr(s.cond)}`];
      for (const inv of s.invariants) lines.push(`${pad}  invariant ${emitExpr(inv)}`);
      if (s.decreasing) lines.push(`${pad}  decreases ${emitExpr(s.decreasing)}`);
      lines.push(`${pad}{`);
      lines.push(emitStmts(s.body, indent + 1));
      lines.push(`${pad}}`);
      return lines.join("\n");
    }

    case "forin": {
      // Lean for-in → Dafny while loop over index
      const idx = escapeName(s.idx);
      const lines = [
        `${pad}var ${idx} := 0;`,
        `${pad}while ${idx} < ${emitExpr(s.bound)}`,
      ];
      for (const inv of s.invariants) lines.push(`${pad}  invariant ${emitExpr(inv)}`);
      lines.push(`${pad}{`);
      lines.push(emitStmts(s.body, indent + 1));
      lines.push(`${pad}  ${idx} := ${idx} + 1;`);
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
  }
}

// ── Declaration emission ────────────────────────────────────

function emitDecl(d: Decl): string {
  _resultName = "res";  // default; methodHeader bumps it if a param is named `res`
  switch (d.kind) {
    case "inductive": {
      const tp = d.typeParams?.length ? `<${d.typeParams.join(", ")}>` : "";
      // Dafny requires a destructor shared across constructors to have a single
      // type. Two TS variants can legitimately share a field name with different
      // types (e.g. label.targetId: string vs leaf.targetId: string?). Detect
      // such collisions and make those destructors per-constructor unique. Safe:
      // variant-field reads lower to positional match bindings, never named
      // destructors on the union (a name shared with differing types isn't even
      // accessible on the union type in TS), so nothing references the old name.
      const typesByField = new Map<string, Set<string>>();
      for (const c of d.constructors)
        for (const f of c.fields) {
          let s = typesByField.get(f.name);
          if (!s) { s = new Set(); typesByField.set(f.name, s); }
          s.add(tyToDafny(f.type));
        }
      const collides = new Set([...typesByField].filter(([, s]) => s.size > 1).map(([n]) => n));
      const ctors = d.constructors.map(c => {
        if (c.fields.length === 0) return dafnyCtorName(c.name);
        const fields = c.fields.map(f => collides.has(f.name) ? { ...f, name: `${f.name}_${c.name.replace(/[^A-Za-z0-9_'?]/g, "_")}` } : f);
        return `${dafnyCtorName(c.name)}(${paramList(fields)})`;
      });
      return `datatype ${escapeName(d.name)}${tp} = ${ctors.join(" | ")}`;
    }

    case "structure": {
      const tp = d.typeParams?.length ? `<${d.typeParams.join(", ")}>` : "";
      return `datatype ${escapeName(d.name)}${tp} = ${escapeName(d.name)}(${paramList(d.fields)})`;
    }

    case "type-alias": {
      return `type ${escapeName(d.name)} = ${tyToDafny(d.target)}`;
    }

    case "opaque-type": {
      // Abstract type — no definition. `(==)` so it can sit inside datatypes
      // that derive structural equality. Never constructed or destructured.
      // `0` (auto-init) only when a havoc of this type needs a witness to
      // satisfy definite assignment — `var x: T := *` requires it.
      const autoInit = _havocedTypeNames.has(d.name) ? ", 0" : "";
      return `type ${escapeName(d.name)}(==${autoInit})`;
    }

    case "def": {
      const tp = d.typeParams.length > 0 ? `<${d.typeParams.join(", ")}>` : "";
      const lines = [`function ${escapeName(d.name)}${tp}(${paramList(d.params)}): ${tyToDafny(d.returnType)}`];
      for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
      if (d.decreases) lines.push(`  decreases ${emitExpr(d.decreases)}`);
      lines.push(`{`);
      lines.push(emitPureExpr(d.body, 1));
      lines.push(`}`);
      // Companion lemma for ensures (proof target for LLM)
      if (d.ensures.length > 0) {
        // Strip constraints like (==) from type params — ghost lemmas don't need them
        const lemmaTP = d.typeParams.length > 0 ? `<${d.typeParams.map(t => t.replace(/\(.*\)/, '')).join(", ")}>` : "";
        lines.push("");
        lines.push(`lemma ${escapeGeneratedName(`${d.name}${ENSURES_LEMMA_SUFFIX}`)}${lemmaTP}(${paramList(d.params)})`);
        for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
        for (const e of d.ensures) lines.push(`  ensures ${emitExpr(e)}`);
        lines.push(`{`);
        lines.push(`}`);
      }
      return lines.join("\n");
    }

    case "def-by-method": {
      const tp = d.typeParams.length > 0 ? `<${d.typeParams.join(", ")}>` : "";
      const lines = [`function ${escapeName(d.name)}${tp}(${paramList(d.params)}): ${tyToDafny(d.returnType)}`];
      for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
      if (d.decreases) lines.push(`  decreases ${emitExpr(d.decreases)}`);
      lines.push(`{`);
      lines.push(`}`);
      lines.push(`by method {`);
      lines.push(emitStmts(d.methodBody, 1));
      lines.push(`}`);
      return lines.join("\n");
    }

    case "method": {
      const tp = d.typeParams.length > 0 ? `<${d.typeParams.join(", ")}>` : "";
      const lines = [methodHeader(`method ${escapeName(d.name)}${tp}`, d.params, d.returnType, d)];
      for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
      for (const e of d.ensures) lines.push(`  ensures ${emitExpr(e)}`);
      if (d.decreases) lines.push(`  decreases ${emitExpr(d.decreases)}`);
      lines.push(`{`);
      lines.push(emitStmts(d.body, 1));
      lines.push(`}`);
      return lines.join("\n");
    }

    case "class": {
      const lines = [`class ${escapeName(d.name)} {`];
      for (const f of d.fields) {
        lines.push(`  var ${escapeName(f.name)}: ${tyToDafny(f.type)}`);
      }
      if (d.fields.length > 0 && d.methods.length > 0) lines.push("");
      for (const m of d.methods) {
        lines.push(`  ${methodHeader(`method ${escapeName(m.name)}`, m.params, m.returnType, m)}`);
        for (const r of m.requires) lines.push(`    requires ${emitExpr(r)}`);
        for (const e of m.ensures) lines.push(`    ensures ${emitExpr(e)}`);
        lines.push(`  {`);
        lines.push(emitStmts(m.body, 2));
        lines.push(`  }`);
      }
      lines.push(`}`);
      return lines.join("\n");
    }

    case "const": {
      return `const ${escapeName(d.name)}: ${tyToDafny(d.type)} := ${emitExpr(d.value)}`;
    }

    case "extern": {
      // `:axiom` makes Dafny accept the missing body. Pure externs are
      // uninterpreted functions (deterministic/extensional); impure externs are
      // methods, so every invocation gets an independent arbitrary result
      // constrained only by its per-call contract.
      const tp = d.typeParams.length > 0 ? `<${d.typeParams.join(", ")}>` : "";
      if (d.impure) {
        const scope = { requires: d.requires, ensures: d.ensures, body: [] as Stmt[] };
        const lines = [methodHeader(
          `method {:axiom} ${escapeName(d.name)}${tp}`,
          d.params, d.returnType, scope, true,
        )];
        for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
        for (const e of d.ensures) lines.push(`  ensures ${emitExpr(e)}`);
        return lines.join("\n");
      }
      const lines = [`function {:axiom} ${escapeName(d.name)}${tp}(${paramList(d.params)}): ${tyToDafny(d.returnType)}`];
      for (const r of d.requires) lines.push(`  requires ${emitExpr(r)}`);
      for (const e of d.ensures) lines.push(`  ensures ${emitExpr(e)}`);
      return lines.join("\n");
    }

    case "namespace": {
      // Dafny doesn't need namespaces — flatten declarations
      return d.decls.map(emitDecl).join("\n\n");
    }
  }
}

// ── File emission ───────────────────────────────────────────

// ── Preamble helpers ────────────────────────────────────────

/** Preamble tracking — emitters add keys via `needPreamble(key)`, emitDafnyFile emits them. */
const _neededPreambles = new Set<string>();
function needPreamble(key: string) { _neededPreambles.add(key); }

/** Effective JS-clamp semantics for `arr.slice(lo, hi)`, resolved from project
 *  config plus file directives before emission. */
let _useSafeSlice = false;

// Source of generated collection helpers, selected independently of string semantics.
let _dafnyLibrary: LscOptions["dafny-library"] = DEFAULT_OPTIONS["dafny-library"];

// The selected model controls literals, character helpers, and verifier flags.
let _stringSemantics: LscOptions["string-semantics"] = DEFAULT_OPTIONS["string-semantics"];
function isUtf16(): boolean { return _stringSemantics === "javascript-utf16"; }

const POW2 = `function Pow2(n: int): int
  requires n >= 0
  decreases n
{
  if n == 0 then 1 else 2 * Pow2(n - 1)
}`;

const BIT_AND = `function BitAnd(x: int, y: int): int
  requires x >= 0 && y >= 0
  decreases x
{
  if x == 0 || y == 0 then 0
  else 2 * BitAnd(x / 2, y / 2) + (if x % 2 == 1 && y % 2 == 1 then 1 else 0)
}`;

const BIT_OR = `function BitOr(x: int, y: int): int
  requires x >= 0 && y >= 0
  decreases x
{
  if x == 0 then y
  else if y == 0 then x
  else 2 * BitOr(x / 2, y / 2) + (if x % 2 == 1 || y % 2 == 1 then 1 else 0)
}`;

const JS_FLOOR_DIV = `function JSFloorDiv(a: int, b: int): int
  requires b != 0
{
  if b > 0 then
    if a >= 0 then a / b
    else -((-a - 1) / b) - 1
  else
    if a <= 0 then (-a) / (-b)
    else -((a - 1) / (-b)) - 1
}`;

const JS_REM = `function JSRem(a: int, b: int): int
  requires b != 0
{
  var r := (if a < 0 then -a else a) % (if b < 0 then -b else b);
  if a < 0 then -r else r
}`;

const JS_TRUNC_DIV = `function JSTruncDiv(a: int, b: int): int
  requires b != 0
{
  var q := (if a < 0 then -a else a) / (if b < 0 then -b else b);
  if (a < 0) != (b < 0) then -q else q
}`;

const JS_STRING_LT = `predicate JSStringLt(s: string, t: string)
  decreases |s|
{
  if |s| == 0 then |t| > 0
  else if |t| == 0 then false
  else if s[0] != t[0] then s[0] < t[0]
  else JSStringLt(s[1..], t[1..])
}`;

const FLOOR_REAL = `function FloorReal(x: real): int
{
  x.Floor
}`;

const CEIL_REAL = `function CeilReal(x: real): int
{
  if x == (x.Floor as real) then x.Floor
  else x.Floor + 1
}`;

const SEQ_FILTER_SOME = `function SeqFilterSome<T>(xs: seq<Option<T>>): seq<T>
  ensures |SeqFilterSome(xs)| <= |xs|
{
  if |xs| == 0 then []
  else (if xs[0].Some? then [xs[0].value] else []) + SeqFilterSome(xs[1..])
}`;

const SEQ_FILTER = `function SeqFilter<T(!new)>(p: T -> bool, xs: seq<T>): seq<T>
  ensures |SeqFilter(p, xs)| <= |xs|
  ensures forall x :: x in SeqFilter(p, xs) <==> x in xs && p(x)
  decreases |xs|
{
  if |xs| == 0 then []
  else (if p(xs[0]) then [xs[0]] else []) + SeqFilter(p, xs[1..])
}`;

const SEQ_ALL = `predicate SeqAll<T>(xs: seq<T>, p: T -> bool)
  decreases |xs|
{
  |xs| == 0 || (p(xs[0]) && SeqAll(xs[1..], p))
}`;

const SEQ_FOLD_LEFT = `function SeqFoldLeft<T, A>(f: (A, T) -> A, init: A, xs: seq<T>): A
  decreases |xs|
{
  if |xs| == 0 then init
  else SeqFoldLeft(f, f(init, xs[0]), xs[1..])
}`;

const SEQ_FIND_INDEX = `function SeqFindIndex<T>(s: seq<T>, p: T -> bool): int
  ensures -1 <= SeqFindIndex(s, p) < |s|
  ensures SeqFindIndex(s, p) >= 0 ==> p(s[SeqFindIndex(s, p)])
  ensures SeqFindIndex(s, p) >= 0 ==>
    (forall i: nat :: i < SeqFindIndex(s, p) ==> !p(s[i]))
  ensures SeqFindIndex(s, p) == -1 ==> (forall i: nat :: i < |s| ==> !p(s[i]))
{
  SeqFindIndexFrom(s, p, 0)
}

function SeqFindIndexFrom<T>(s: seq<T>, p: T -> bool, from: nat): int
  requires from <= |s|
  ensures -1 <= SeqFindIndexFrom(s, p, from) < |s|
  ensures SeqFindIndexFrom(s, p, from) >= 0 ==>
    from <= SeqFindIndexFrom(s, p, from) && p(s[SeqFindIndexFrom(s, p, from)])
  ensures SeqFindIndexFrom(s, p, from) >= 0 ==>
    (forall i: nat :: from <= i < SeqFindIndexFrom(s, p, from) ==> !p(s[i]))
  ensures SeqFindIndexFrom(s, p, from) == -1 ==>
    (forall i: nat :: from <= i < |s| ==> !p(s[i]))
  decreases |s| - from
{
  if from >= |s| then -1
  else if p(s[from]) then from as int
  else SeqFindIndexFrom(s, p, from + 1)
}`;

const SEQ_INDEX_OF = `function SeqIndexOf<T(==)>(s: seq<T>, x: T): int
  ensures -1 <= SeqIndexOf(s, x) < |s|
  ensures SeqIndexOf(s, x) >= 0 ==> s[SeqIndexOf(s, x)] == x
  ensures SeqIndexOf(s, x) == -1 ==> x !in s
{
  SeqIndexOfFrom(s, x, 0)
}

function SeqIndexOfFrom<T(==)>(s: seq<T>, x: T, from: nat): int
  requires from <= |s|
  ensures -1 <= SeqIndexOfFrom(s, x, from) < |s|
  ensures SeqIndexOfFrom(s, x, from) >= 0 ==> s[SeqIndexOfFrom(s, x, from)] == x
  ensures SeqIndexOfFrom(s, x, from) == -1 ==> forall i :: from <= i < |s| ==> s[i] != x
  decreases |s| - from
{
  if from == |s| then -1
  else if s[from] == x then from as int
  else SeqIndexOfFrom(s, x, from + 1)
}`;

const SEQ_FIND_LAST_INDEX = `function SeqFindLastIndex<T>(s: seq<T>, p: T -> bool): int
  ensures -1 <= SeqFindLastIndex(s, p) < |s|
  ensures SeqFindLastIndex(s, p) >= 0 ==> p(s[SeqFindLastIndex(s, p)])
  ensures SeqFindLastIndex(s, p) >= 0 ==>
    (forall j: int :: SeqFindLastIndex(s, p) < j < |s| ==> !p(s[j]))
  ensures SeqFindLastIndex(s, p) == -1 ==> (forall i: nat :: i < |s| ==> !p(s[i]))
  decreases |s|
{
  if |s| == 0 then -1
  else if p(s[|s|-1]) then |s| - 1
  else SeqFindLastIndex(s[..|s|-1], p)
}`;

const SEQ_FIND = `function SeqFind<T>(s: seq<T>, p: T -> bool): Option<T>
  ensures SeqFind(s, p).Some? ==> p(SeqFind(s, p).value)
  ensures SeqFind(s, p).Some? ==> SeqFind(s, p).value in s
  ensures SeqFind(s, p).Some? ==>
    exists i: nat :: i < |s| && s[i] == SeqFind(s, p).value && p(s[i]) &&
                     (forall j: nat :: j < i ==> !p(s[j]))
  ensures SeqFind(s, p).None? ==> forall i :: 0 <= i < |s| ==> !p(s[i])
  decreases |s|
{
  if |s| == 0 then None
  else if p(s[0]) then Some(s[0])
  else SeqFind(s[1..], p)
}`;

const SEQ_FIND_LAST = `function SeqFindLast<T>(s: seq<T>, p: T -> bool): Option<T>
  ensures SeqFindLast(s, p).Some? ==> p(SeqFindLast(s, p).value)
  ensures SeqFindLast(s, p).Some? ==> SeqFindLast(s, p).value in s
  ensures SeqFindLast(s, p).Some? ==>
    exists i: nat :: i < |s| && s[i] == SeqFindLast(s, p).value && p(s[i]) &&
                     (forall j: nat :: i < j < |s| ==> !p(s[j]))
  ensures SeqFindLast(s, p).None? ==> forall i :: 0 <= i < |s| ==> !p(s[i])
  decreases |s|
{
  if |s| == 0 then None
  else if p(s[|s|-1]) then Some(s[|s|-1])
  else SeqFindLast(s[..|s|-1], p)
}`;

const SEQ_FLATTEN = `function SeqFlatten<T>(s: seq<seq<T>>): seq<T>
  decreases |s|
{
  if |s| == 0 then []
  else s[0] + SeqFlatten(s[1..])
}`;

const SEQ_JOIN = `function SeqJoin(s: seq<string>, sep: string): string
  decreases |s|
{
  if |s| == 0 then ""
  else if |s| == 1 then s[0]
  else s[0] + sep + SeqJoin(s[1..], sep)
}`;

const SAFE_SLICE = `function NormalizeSliceIndex(n: nat, i: int): int
  ensures 0 <= NormalizeSliceIndex(n, i) <= n as int
{
  if i < 0 then
    if n as int + i < 0 then 0 else n as int + i
  else if i > n as int then n as int
  else i
}

function SafeSlice<T>(s: seq<T>, lo: int, hi: int): seq<T>
  ensures |SafeSlice(s, lo, hi)| <= |s|
{
  var lo' := NormalizeSliceIndex(|s|, lo);
  var hi' := NormalizeSliceIndex(|s|, hi);
  if hi' < lo' then [] else s[lo'..hi']
}`;

const STRING_SEARCH_POSITION = `function StringSearchPosition(s: string, position: int): nat
  ensures StringSearchPosition(s, position) <= |s|
{
  if position < 0 then 0 else if position > |s| then |s| else position
}`;

const STRING_STARTS_WITH_AT = `function StringStartsWithAt(s: string, sub: string, position: int): bool
{
  var start := StringSearchPosition(s, position);
  |sub| <= |s| - start && s[start..start + |sub|] == sub
}`;

const STRING_ENDS_WITH_AT = `function StringEndsWithAt(s: string, sub: string, position: int): bool
{
  var end := StringSearchPosition(s, position);
  |sub| <= end && s[end - |sub|..end] == sub
}`;

const STRING_INDEX_OF = `function StringIndexOf(s: string, sub: string): int
  ensures StringIndexOf(s, sub) == -1
       || (0 <= StringIndexOf(s, sub) <= |s| - |sub| && s[StringIndexOf(s, sub)..StringIndexOf(s, sub) + |sub|] == sub)
{
  StringIndexOfFrom(s, sub, 0)
}

function StringIndexOfFrom(s: string, sub: string, from: int): int
  ensures StringIndexOfFrom(s, sub, from) == -1
       || (0 <= StringIndexOfFrom(s, sub, from) <= |s| - |sub|
           && s[StringIndexOfFrom(s, sub, from)..StringIndexOfFrom(s, sub, from) + |sub|] == sub
           && StringIndexOfFrom(s, sub, from) >= from)
{
  StringIndexOfFromN(s, sub, if from < 0 then 0 else from)
}

function StringIndexOfFromN(s: string, sub: string, from: nat): int
  decreases |s| - from
  ensures StringIndexOfFromN(s, sub, from) == -1
       || (from <= StringIndexOfFromN(s, sub, from) <= |s| - |sub|
           && s[StringIndexOfFromN(s, sub, from)..StringIndexOfFromN(s, sub, from) + |sub|] == sub)
{
  if from + |sub| > |s| then -1
  else if s[from..from + |sub|] == sub then from as int
  else StringIndexOfFromN(s, sub, from + 1)
}`;

// `s.split(d)` in TS returns a non-empty sequence of segments. Modeled here as
// an axiom — defining it recursively would force StringIndexOf to grow ensures
// clauses that callers don't need. The two ensures cover what verification
// usually wants: result has at least one element, and every element fits
// within the source length.
const STRING_SPLIT = `function {:axiom} StringSplit(s: string, d: string): seq<string>
  requires |d| > 0
  ensures |StringSplit(s, d)| >= 1
  ensures |StringSplit(s, d)| <= |s| + 1
  ensures forall k :: 0 <= k < |StringSplit(s, d)| ==> |StringSplit(s, d)[k]| <= |s|`;

// `xs.sort(cmp)` in TS sorts in place by a comparator (negative ⟺ a before b).
// Modeled here as an axiom returning a permutation sorted by cmp. The `requires`
// is the soundness condition — cmp must be a total preorder, otherwise no sorted
// permutation exists and the axiom would be vacuous. Callers discharge it (e.g.
// `(a,b) => a.k - b.k` is total + transitive by linear arithmetic).
// Bare `.sort()`: permutation only, no sortedness (JS default order is type-dependent).
const SEQ_SORT = `function {:axiom} SeqSort<T(==,!new)>(s: seq<T>): seq<T>
  ensures multiset(SeqSort(s)) == multiset(s)
  ensures |SeqSort(s)| == |s|`;

const SEQ_SORT_BY = `function {:axiom} SeqSortBy<T(==,!new)>(s: seq<T>, cmp: (T, T) -> int): seq<T>
  requires forall a: T, b: T :: cmp(a, b) <= 0 || cmp(b, a) <= 0
  requires forall a: T, b: T, c: T :: cmp(a, b) <= 0 && cmp(b, c) <= 0 ==> cmp(a, c) <= 0
  ensures multiset(SeqSortBy(s, cmp)) == multiset(s)
  ensures |SeqSortBy(s, cmp)| == |s|
  ensures forall i: int, j: int :: 0 <= i <= j < |SeqSortBy(s, cmp)| ==> cmp(SeqSortBy(s, cmp)[i], SeqSortBy(s, cmp)[j]) <= 0`;

// TS/JS String.prototype.trim() strips ECMAScript WhiteSpace ∪ LineTerminator:
// Unicode general-category Zs plus TAB/VT/FF/CR/LF, LS/PS, and the BOM — NOT just
// U+0020, and NOT U+0085 (NEL, which is Cc). See
// https://tc39.es/ecma262/#sec-white-space and
// https://tc39.es/ecma262/#sec-line-terminators.
// `\\uXXXX` is Dafny's escape form under --unicode-char:false and `\\U{XXXX}`
// under :true (each rejects the other); STRING_TRIM_SCALAR derives the latter.
// The enumeration below is emitted Dafny source, not a decoded JS string.
const STRING_TRIM = `predicate IsJSWhitespace(c: char)
{
  c == '\\u0009' || c == '\\u000A' || c == '\\u000B' || c == '\\u000C' || c == '\\u000D' ||
  c == '\\u0020' || c == '\\u00A0' || c == '\\u1680' ||
  ('\\u2000' <= c <= '\\u200A') ||
  c == '\\u2028' || c == '\\u2029' || c == '\\u202F' || c == '\\u205F' ||
  c == '\\u3000' || c == '\\uFEFF'
}

function StringTrimLeft(s: string): string
  ensures |StringTrimLeft(s)| <= |s|
  ensures StringTrimLeft(s) == "" || (|StringTrimLeft(s)| > 0 && !IsJSWhitespace(StringTrimLeft(s)[0]))
  decreases |s|
{
  if |s| == 0 then ""
  else if IsJSWhitespace(s[0]) then StringTrimLeft(s[1..])
  else s
}

function StringTrimRight(s: string): string
  ensures |StringTrimRight(s)| <= |s|
  ensures StringTrimRight(s) == "" || (|StringTrimRight(s)| > 0 && !IsJSWhitespace(StringTrimRight(s)[|StringTrimRight(s)|-1]))
  decreases |s|
{
  if |s| == 0 then ""
  else if IsJSWhitespace(s[|s|-1]) then StringTrimRight(s[..|s|-1])
  else s
}

function StringTrim(s: string): string
{
  StringTrimRight(StringTrimLeft(s))
}`;

// The same predicate and trims under `--unicode-char:true`, which the
// `unicode-scalar` profile verifies under: byte-identical to what was always emitted.
const STRING_TRIM_SCALAR = STRING_TRIM.replace(/\\u([0-9A-F]{4})/g, "\\U{$1}");

const STRING_TO_LOWER = `function StringToLower(s: string): string
  ensures |StringToLower(s)| == |s|
  decreases |s|
{
  if |s| == 0 then ""
  else
    var c := s[0];
    var lower := if 'A' <= c <= 'Z' then (c - 'A' + 'a') as char else c;
    [lower] + StringToLower(s[1..])
}`;

const STRING_TO_UPPER = `function StringToUpper(s: string): string
  ensures |StringToUpper(s)| == |s|
  decreases |s|
{
  if |s| == 0 then ""
  else
    var c := s[0];
    var upper := if 'a' <= c <= 'z' then (c - 'a' + 'A') as char else c;
    [upper] + StringToUpper(s[1..])
}`;

// `String.fromCharCode(n)` — the inverse of `s.charCodeAt(i)`'s `(s[i] as int)`
// in the UTF-16 code-unit model selected by dafny-commands.ts. LemmaScript
// currently admits the direct 16-bit range; JavaScript's wider ToUint16 coercion
// remains outside the verified subset.
const STRING_FROM_CHAR_CODE = `function StringFromCharCode(n: int): string
  requires 0 <= n < 0x10000
  ensures |StringFromCharCode(n)| == 1
  ensures (StringFromCharCode(n)[0] as int) == n
{
  [n as char]
}`;

// `unicode-scalar` keeps the scalar range that was always required: a surrogate
// is refused by precondition rather than admitted as a code unit.
const STRING_FROM_CHAR_CODE_SCALAR = STRING_FROM_CHAR_CODE.replace(
  "requires 0 <= n < 0x10000",
  "requires 0 <= n < 0xD800 || 0xE000 <= n < 0x110000",
);

// `s.repeat(n)` — n copies of s, concatenated. The per-index ensures is stated
// for the single-character receiver (the common case: padding with one digit).
const STRING_REPEAT = `function StringRepeat(s: string, n: int): string
  requires n >= 0
  ensures |StringRepeat(s, n)| == |s| * n
  ensures |s| == 1 ==> forall i :: 0 <= i < n ==> StringRepeat(s, n)[i] == s[0]
  decreases n
{
  if n == 0 then "" else s + StringRepeat(s, n - 1)
}`;

const MATH_MIN = `function MathMin(a: int, b: int): int { if a <= b then a else b }`;
const MATH_MAX = `function MathMax(a: int, b: int): int { if a >= b then a else b }`;

const MAX_OF_SEQ = `function MaxOfSeq(s: seq<int>): int
  requires |s| > 0
  ensures forall i: nat :: i < |s| ==> s[i] <= MaxOfSeq(s)
  ensures exists i: nat :: i < |s| && s[i] == MaxOfSeq(s)
  decreases |s|
{
  if |s| == 1 then s[0]
  else MathMax(s[0], MaxOfSeq(s[1..]))
}

// Helper for proofs about MaxOfSeq applied to concatenations. Users invoke
// this in _ensures lemma bodies when Dafny doesn't automatically connect
// indices through (a + b)[i].
lemma MaxOfSeqConcat(a: seq<int>, b: seq<int>)
  requires |a| + |b| > 0
  ensures forall i: nat :: i < |a| ==> a[i] <= MaxOfSeq(a + b)
  ensures forall i: nat :: i < |b| ==> b[i] <= MaxOfSeq(a + b)
{
  forall i: nat | i < |a| ensures a[i] <= MaxOfSeq(a + b) {
    assert (a + b)[i] == a[i];
  }
  forall i: nat | i < |b| ensures b[i] <= MaxOfSeq(a + b) {
    assert (a + b)[|a| + i] == b[i];
  }
}`;

const MIN_OF_SEQ = `function MinOfSeq(s: seq<int>): int
  requires |s| > 0
  ensures forall i: nat :: i < |s| ==> MinOfSeq(s) <= s[i]
  ensures exists i: nat :: i < |s| && s[i] == MinOfSeq(s)
  decreases |s|
{
  if |s| == 1 then s[0]
  else MathMin(s[0], MinOfSeq(s[1..]))
}

lemma MinOfSeqConcat(a: seq<int>, b: seq<int>)
  requires |a| + |b| > 0
  ensures forall i: nat :: i < |a| ==> MinOfSeq(a + b) <= a[i]
  ensures forall i: nat :: i < |b| ==> MinOfSeq(a + b) <= b[i]
{
  forall i: nat | i < |a| ensures MinOfSeq(a + b) <= a[i] {
    assert (a + b)[i] == a[i];
  }
  forall i: nat | i < |b| ensures MinOfSeq(a + b) <= b[i] {
    assert (a + b)[|a| + i] == b[i];
  }
}`;

const NAT_TO_STRING = `function NatToString(n: nat): string
  decreases n
{
  var digit := ('0' as int + n % 10) as char;
  if n < 10 then [digit]
  else NatToString(n / 10) + [digit]
}`;

const INT_TO_STRING = `function IntToString(n: int): string
{
  if n < 0 then "-" + NatToString(-n) else NatToString(n)
}`;

const MATH_ABS = `function MathAbs(x: int): nat { if x >= 0 then x else -x }`;

// perm(a, b) — `a` and `b` are reorderings of each other (equal as multisets).
// Transparent (Dafny unfolds it), so hand-proofs can reason with `multiset`
// directly. The `(==)` bound requires the element type to support equality.
const PERM = `predicate Perm<T(==)>(a: seq<T>, b: seq<T>) { multiset(a) == multiset(b) }`;

const SET_FROM_SEQ = `function SetFromSeq<T(==)>(s: seq<T>): set<T> { set x | x in s }`;

const SET_TO_SEQ = `method SetToSeq<T>(s: set<T>) returns (res: seq<T>)
  ensures forall x :: x in s <==> x in res
  ensures |res| == |s|
  ensures forall i, j :: 0 <= i < j < |res| ==> res[i] != res[j]
{
  var remaining := s;
  res := [];
  while remaining != {}
    invariant remaining <= s
    invariant forall x :: x in res <==> (x in s && x !in remaining)
    invariant |res| + |remaining| == |s|
    invariant forall i, j :: 0 <= i < j < |res| ==> res[i] != res[j]
    decreases remaining
  {
    var x :| x in remaining;
    res := res + [x];
    remaining := remaining - {x};
  }
}`;

/** Preamble code keyed by name. Emitted in this order when needed. */
const PREAMBLE_CODE: [string, string | (() => string)][] = [
  ["OptionType", "datatype Option<T> = None | Some(value: T)"],
  // Opaque carrier for `unknown`-typed values. `(==)` for compare/map-key/match;
  // `(0)` (auto-init ⇒ nonempty) so `havoc` (`:= *`) is well-formed.
  ["UnknownType", "type Unknown(==, 0)"],
  ["SetToSeq", SET_TO_SEQ],
  ["Pow2", POW2],
  ["BitAnd", BIT_AND],
  ["BitOr", BIT_OR],
  ["JSFloorDiv", JS_FLOOR_DIV],
  ["JSRem", JS_REM],
  ["JSTruncDiv", JS_TRUNC_DIV],
  ["JSStringLt", JS_STRING_LT],
  ["CeilReal", CEIL_REAL],
  ["FloorReal", FLOOR_REAL],
  ["SeqIndexOf", SEQ_INDEX_OF],
  ["SeqFindIndex", SEQ_FIND_INDEX],
  ["SeqFindLastIndex", SEQ_FIND_LAST_INDEX],
  ["SeqFilter", SEQ_FILTER],
  ["SeqAll", SEQ_ALL],
  ["SeqFoldLeft", SEQ_FOLD_LEFT],
  ["SeqFilterSome", SEQ_FILTER_SOME],
  ["SeqFind", SEQ_FIND],
  ["SeqFindLast", SEQ_FIND_LAST],
  ["SeqFlatten", SEQ_FLATTEN],
  ["SeqJoin", SEQ_JOIN],
  ["SafeSlice", SAFE_SLICE],
  ["StringIndexOf", STRING_INDEX_OF],
  ["StringSearchPosition", STRING_SEARCH_POSITION],
  ["StringStartsWithAt", STRING_STARTS_WITH_AT],
  ["StringEndsWithAt", STRING_ENDS_WITH_AT],
  ["StringSplit", STRING_SPLIT],
  ["SeqSort", SEQ_SORT],
  ["SeqSortBy", SEQ_SORT_BY],
  ["StringTrim", () => isUtf16() ? STRING_TRIM : STRING_TRIM_SCALAR],
  ["StringToLower", STRING_TO_LOWER],
  ["StringToUpper", STRING_TO_UPPER],
  ["StringFromCharCode", () => isUtf16() ? STRING_FROM_CHAR_CODE : STRING_FROM_CHAR_CODE_SCALAR],
  ["StringRepeat", STRING_REPEAT],
  ["NatToString", NAT_TO_STRING],
  ["IntToString", INT_TO_STRING],
  ["MathAbs", MATH_ABS],
  ["MathMin", MATH_MIN],
  ["MathMax", MATH_MAX],
  ["MaxOfSeq", MAX_OF_SEQ],
  ["MinOfSeq", MIN_OF_SEQ],
  ["Perm", PERM],
  ["SetFromSeq", SET_FROM_SEQ],
];

/**
 * The names of the functions, predicates, lemmas and methods declared in Dafny
 * `text`, in order: a declaration starts its line, may carry modifiers
 * (`ghost`, `opaque`, …) and attributes (`{:axiom}`), and is never in a comment.
 */
export function declaredNames(text: string): string[] {
  const declaration = /^\s*(?:(?:ghost|opaque|static|twostate|least|greatest)\s+)*(?:function|predicate|lemma|method)(?:\s+\{:[^}]*\})*\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  return [...text.matchAll(declaration)].map(m => m[1]);
}

/**
 * Every function, predicate, lemma and method the preambles declare, so tools reading
 * Dafny results can tell lsc's own helpers from the user's members. The
 * profile-dependent entries only change literals, so either variant gives the same names.
 */
export const DAFNY_HELPER_NAMES: ReadonlySet<string> = new Set(
  PREAMBLE_CODE.flatMap(([, code]) => declaredNames(typeof code === "function" ? code() : code)),
);

// ── Constructor and record helpers ───────────────────────────

let _recordCtors = new Map<string, string>();
let _structureDecls = new Map<string, { name: string; type: Ty }[]>();
let _declaredTypes = new Set<string>();
let _ambiguousCtors = new Set<string>();
// `"<union>.<ctor>.<field>"` → per-constructor destructor name, for fields the
// inductive emission renames (shared name, differing types). Field reads and
// datatype updates with a pinned ctor must use the renamed destructor.
let _ctorFieldRenames = new Map<string, string>();

function buildRecordCtorMap(decls: Decl[]) {
  _recordCtors = new Map();
  _structureDecls = new Map();
  _declaredTypes = new Set();
  _ambiguousCtors = new Set();
  _ctorFieldRenames = new Map();
  const ctorSeen = new Set<string>();
  function collectDecl(d: Decl) {
    if (d.kind === "structure") {
      _declaredTypes.add(d.name);
      _structureDecls.set(d.name, d.fields);
      if (d.fields.length > 0) _recordCtors.set(d.fields[0].name, d.name);
    }
    if (d.kind === "inductive") {
      _declaredTypes.add(d.name);
      // Constructor names shared by two datatypes in this module (Expr.let vs
      // Stmt.let) can't be used bare — emitters must qualify them.
      for (const c of d.constructors) {
        if (ctorSeen.has(c.name)) _ambiguousCtors.add(c.name);
        ctorSeen.add(c.name);
      }
      // Mirror the destructor renaming the inductive case of emitDecl performs
      // (shared field name, differing types → per-constructor names), so reads
      // and updates can be translated to the renamed destructors.
      const typesByField = new Map<string, Set<string>>();
      for (const c of d.constructors)
        for (const f of c.fields) {
          let s = typesByField.get(f.name);
          if (!s) { s = new Set(); typesByField.set(f.name, s); }
          s.add(tyToDafny(f.type));
        }
      const collides = new Set([...typesByField].filter(([, s]) => s.size > 1).map(([n]) => n));
      for (const c of d.constructors)
        for (const f of c.fields) {
          if (!collides.has(f.name)) continue;
          _ctorFieldRenames.set(`${d.name}.${c.name}.${f.name}`,
            `${f.name}_${c.name.replace(/[^A-Za-z0-9_'?]/g, "_")}`);
        }
    }
    if (d.kind === "type-alias") _declaredTypes.add(d.name);
    if (d.kind === "def") _declaredTypes.add(d.name);
    if (d.kind === "namespace") for (const inner of d.decls) collectDecl(inner);
  }
  for (const d of decls) collectDecl(d);
}

/** Resolve a Ty to a Dafny-safe type, falling back to string for undeclared user types. */
function resolveTy(ty: Ty): Ty {
  if (ty.kind === "user" && !_declaredTypes.has(ty.name)) return { kind: "string" };
  if (ty.kind === "optional") return { kind: "optional", inner: resolveTy(ty.inner) };
  if (ty.kind === "array") return { kind: "array", elem: resolveTy(ty.elem) };
  if (ty.kind === "tuple") return { kind: "tuple", elems: ty.elems.map(resolveTy) };
  if (ty.kind === "map") return { kind: "map", key: resolveTy(ty.key), value: resolveTy(ty.value) };
  if (ty.kind === "set") return { kind: "set", elem: resolveTy(ty.elem) };
  return ty;
}

/** Constructor names come from source strings (string-union values like
 *  "spec-pure", discriminated-union tags), which may contain characters no
 *  TS identifier has; map those to `_` before the ordinary escaping. A
 *  collision after mapping fails loudly in Dafny (duplicate constructor)
 *  rather than silently merging. */
function dafnyCtorName(name: string): string {
  return escapeName(name.replace(/[^A-Za-z0-9_'?]/g, "_"));
}

function qualifyCtor(name: string, type?: string): string {
  const rawName = name.replace(/^\./, "");
  // hasOwn: a ctor literally named "constructor" (the IR's own Expr variant)
  // must not hit Object.prototype.constructor through the bare index.
  const mapped = (Object.hasOwn(CTOR_MAP, rawName) ? CTOR_MAP[rawName] : undefined) ?? dafnyCtorName(rawName);
  if (type) return `${type}.${mapped}`;
  return mapped;
}

/** Translate a backend-neutral match pattern to Dafny syntax.
 *  ".ctorName field1 field2" → "ctorName(field1, field2)"
 *  ".ctorName" → "ctorName"
 *  literal value → quoted Dafny string
 *  "_" → "_"
 */
const CTOR_MAP: Record<string, string> = { "some": "Some", "none": "None" };

function translatePattern(p: MatchPattern): string {
  if (p.kind === "wild") return "_";
  if (p.kind === "literal") return emitExpr({ kind: "str", value: p.value });
  const ctorName = (Object.hasOwn(CTOR_MAP, p.ctor) ? CTOR_MAP[p.ctor] : undefined) ?? dafnyCtorName(p.ctor);
  if (p.binders.length === 0) return ctorName;
  return `${ctorName}(${p.binders.map(escapeName).join(", ")})`;
}


export function emitDafnyFile(file: Module, tsFileName?: string, options: LscOptions = DEFAULT_OPTIONS): string {
  // Programmatic callers share the CLI's compatibility checks.
  options = resolveOptions(options, tsFileName ?? "Dafny emission");
  _useSafeSlice = options["safe-slice"];
  _stringSemantics = options["string-semantics"];
  _dafnyLibrary = options["dafny-library"];
  resetDafnyNameCache();
  buildRecordCtorMap(file.decls);
  _neededPreambles.clear();
  _havocedTypeNames.clear();
  collectHavocedTypeNames(file.decls, _havocedTypeNames);

  // Track successfully emitted pure defs — method wrappers are only
  // skipped when the corresponding pure def was actually emitted.
  const emittedPureDefs = new Set<string>();

  // Emit a decl, rolling back any preamble requirements it registered if it
  // throws, so callers that catch an emission error never observe partial
  // emitter state.
  const emitDeclTx = (d: Decl): string => {
    const saved = new Set(_neededPreambles);
    try {
      return emitDecl(d);
    } catch (e) {
      _neededPreambles.clear();
      for (const k of saved) _neededPreambles.add(k);
      throw e;
    }
  };

  // Emit declarations
  const declLines: string[] = [];
  for (const decl of file.decls) {
    if (decl.kind === "method" && emittedPureDefs.has(decl.name)) continue;
    if (decl.kind === "namespace") {
      // Emit each inner declaration separately so failures name the exact
      // pure declaration that could not be translated.
      for (const inner of decl.decls) {
        try {
          declLines.push("");
          declLines.push(emitDeclTx(inner));
          if (inner.kind === "def") emittedPureDefs.add(inner.name);
        } catch (e) {
          const name = "name" in inner ? inner.name : "unknown";
          const reason = e instanceof Error ? e.message : String(e);
          const source = tsFileName ? ` in ${tsFileName}` : "";
          throw new Error(`Dafny emission failed for '${name}'${source}: ${reason}`);
        }
      }
      continue;
    }
    try {
      declLines.push("");
      declLines.push(emitDeclTx(decl));
      if (decl.kind === "def-by-method") emittedPureDefs.add(decl.name);
    } catch (e) {
      const name = "name" in decl ? decl.name : "unknown";
      const reason = e instanceof Error ? e.message : String(e);
      const source = tsFileName ? ` in ${tsFileName}` : "";
      throw new Error(`Dafny emission failed for '${name}'${source}: ${reason}`);
    }
  }

  // Build output with needed preambles
  const lines: string[] = [];
  if (tsFileName) lines.push(`// Generated by lsc from ${tsFileName}`);
  // Record every UTF-16 selection, including strings introduced by helpers.
  if (isUtf16()) lines.push("// lsc options: string-semantics=javascript-utf16");
  for (const [key, code] of PREAMBLE_CODE) {
    if (_neededPreambles.has(key)) { lines.push(""); lines.push(typeof code === "function" ? code() : code); }
  }
  lines.push(...declLines);
  return lines.join("\n") + "\n";
}
