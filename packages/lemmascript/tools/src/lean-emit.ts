/**
 * Lean emitter — IR → Lean text. Beyond serialization it makes type-driven
 * decisions: Bool-vs-Prop connectives, dropping Repr/DecidableEq for
 * opaque-tainted types, discriminator/destructor lowering, method dispatch,
 * and support-import selection.
 */

import type { Expr, Stmt, Decl, Module, MatchPattern } from "./ir.js";
import { anyExpr, usesNameInDecl, patternBinders } from "./ir.js";
import type { Ty } from "./typedir.js";
import { freshName, freshNameWhere } from "./names.js";

// ── Ty → Lean type string ──────────────────────────────────

function tyToLean(ty: Ty): string {
  switch (ty.kind) {
    case "nat": return "Nat";
    case "int": return "Int";
    case "real":
      // Real arithmetic isn't supported by the Lean backend yet: ℝ is
      // noncomputable and needs Mathlib's real-number development, so we fail
      // fast here rather than emit Lean that can't compile.
      //
      // Workarounds, in order of preference:
      //   1. If integer division was intended, write `Math.floor(a / b)` — it
      //      lowers to flooring integer division on Lean (no real involved).
      //   2. For `bigint` operands, `/` is already integer division — declaring
      //      the value `bigint` instead of `number` keeps it off the real path.
      //   3. If the file genuinely needs reals, restrict it to Dafny with a
      //      `//@ backend dafny` directive.
      // Full Lean real support is feasible but was set aside: it needs
      // `import Mathlib.Data.Real.Basic`, `noncomputable def`s for real-valued
      // functions, and the Int→ℝ coercion (see the stashed WIP for a sketch).
      throw new Error("real arithmetic is not supported by the Lean backend (needs noncomputable ℝ / Mathlib).");
    case "bool": return "Bool";
    case "string": return "String";
    case "void": return "Unit";
    case "array": {
      const elem = tyToLean(ty.elem);
      return elem.includes(" ") ? `Array (${elem})` : `Array ${elem}`;
    }
    case "tuple":
      // Right-nested Prod: `A × B × C` = `A × (B × C)`. Parenthesize any element
      // whose rendering has a space so it binds tighter than `×` (e.g. `A → B`).
      return ty.elems.map(el => {
        const s = tyToLean(el);
        return s.includes(" ") ? `(${s})` : s;
      }).join(" × ");
    case "map": {
      const k = tyToLean(ty.key);
      const v = tyToLean(ty.value);
      const kStr = k.includes(" ") ? `(${k})` : k;
      const vStr = v.includes(" ") ? `(${v})` : v;
      return `Std.HashMap ${kStr} ${vStr}`;
    }
    case "set": {
      const elem = tyToLean(ty.elem);
      return elem.includes(" ") ? `Std.HashSet (${elem})` : `Std.HashSet ${elem}`;
    }
    case "optional": {
      const inner = tyToLean(ty.inner);
      return inner.includes(" ") ? `Option (${inner})` : `Option ${inner}`;
    }
    case "user": return ty.name;
    case "fn": {
      const params = ty.params.map(p => {
        const s = tyToLean(p);
        return s.includes(" ") ? `(${s})` : s;
      });
      const ret = tyToLean(ty.result);
      const retStr = ret.includes(" ") ? `(${ret})` : ret;
      return [...params, retStr].join(" → ");
    }
    // Out-of-subset (`any`/`unknown`) — an opaque carrier, so unmodeled payloads
    // (e.g. a `details` field never inspected by the verified code) pass through
    // but real ops on them fail loudly. Mirrors the Dafny backend's
    // `type Unknown(==, 0)`. The decl is emitted once, in the first file that
    // needs it (the def file imports the types file, so no duplicate).
    case "unknown": _needsUnknown = true; return "Unknown";
  }
}

// ── Lean keyword escaping ────────────────────────────────────

const LEAN_KEYWORDS = new Set([
  "def", "theorem", "lemma", "example", "structure", "class", "instance",
  "inductive", "where", "match", "with", "if", "then", "else", "do",
  "let", "mut", "return", "for", "in", "while", "break", "continue",
  "import", "open", "section", "namespace", "end", "set_option",
  "variable", "axiom", "constant", "private", "protected", "noncomputable",
  "partial", "unsafe", "macro", "syntax", "by", "fun", "have", "show",
  "at", "from", "to", "deriving", "extends", "true", "false",
]);

// The return-value identifier for the method currently being emitted. Default
// `res`, but primed (e.g. `res'`) when a module identifier is named `res` — set
// by the method case. `\result` in an ensures/body must use the same name.
let _resultName = "res";
let _invariantIndex = 0;
let _rangeIndex = 0;

function escapeName(name: string): string {
  // \result is carried through the IR as the var name "\\result"; render it
  // as the method's return-value identifier (matches `returns (res : T)`).
  if (name === "\\result") return _resultName;
  return LEAN_KEYWORDS.has(name) ? `«${name}»` : name;
}

// ── Operator precedence (for parenthesization) ──────────────

const PREC: Record<string, number> = {
  "↔": 0,  // Lean: Iff (20) binds looser than → (25)
  "→": 1, "∨": 2, "∧": 3,
  "=": 4, "≠": 4, "≥": 4, "≤": 4, ">": 4, "<": 4,
  "+": 5, "-": 5, "++": 5, "arrayConcat": 5, "*": 6, "/": 6, "%": 6,
};

function prec(op: string): number { return PREC[op] ?? 10; }

// ── Constructor registry (for union discriminator/destructor lowering) ──
//
// Lean, unlike Dafny, has no `x.Ctor?` discriminator test or `x.field`
// projection on a multi-constructor inductive — both must be lowered to a
// `match`. Doing so needs each union's constructor shapes. The inductives live
// in the `.types.lean` file, but discriminator/destructor expressions also
// appear in the `.def.lean` method bodies; since `lsc` emits both files in one
// process (types first), we accumulate the registry across calls rather than
// clearing it per file.
type CtorInfo = { name: string; fields: { name: string; type: Ty }[] };
const _unionCtors = new Map<string, CtorInfo[]>();

// Types that transitively reference an `opaque` type can't derive `Repr` or
// `DecidableEq` (the opaque type provides neither). `Inhabited` still derives
// (via the empty array / first constructor), so only those two are dropped.
// "Unknown" (the `any`/`unknown` carrier) is opaque by construction.
const _opaqueNames = new Set<string>(["Unknown"]);
const _typeRefs = new Map<string, Set<string>>();
const _taintedTypes = new Set<string>();

function collectUserRefs(ty: Ty, into: Set<string>): void {
  switch (ty.kind) {
    case "array": case "set": collectUserRefs(ty.elem, into); break;
    case "tuple": ty.elems.forEach(el => collectUserRefs(el, into)); break;
    case "optional": collectUserRefs(ty.inner, into); break;
    case "map": collectUserRefs(ty.key, into); collectUserRefs(ty.value, into); break;
    case "fn": ty.params.forEach(p => collectUserRefs(p, into)); collectUserRefs(ty.result, into); break;
    case "user": into.add(ty.name.includes("<") ? ty.name.slice(0, ty.name.indexOf("<")) : ty.name); break;
    case "unknown": into.add("Unknown"); break;
  }
}

function registerInductives(decls: Decl[]): void {
  for (const d of decls) {
    if (d.kind === "inductive") {
      _unionCtors.set(d.name, d.constructors);
      const refs = new Set<string>();
      for (const c of d.constructors) for (const f of c.fields) collectUserRefs(f.type, refs);
      _typeRefs.set(d.name, refs);
    } else if (d.kind === "structure") {
      const refs = new Set<string>();
      for (const f of d.fields) collectUserRefs(f.type, refs);
      _typeRefs.set(d.name, refs);
    } else if (d.kind === "opaque-type") {
      _opaqueNames.add(d.name);
    }
  }
  // Fixpoint: a type is tainted if it references an opaque or already-tainted type.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, refs] of _typeRefs) {
      if (_taintedTypes.has(name)) continue;
      if ([...refs].some(r => _opaqueNames.has(r) || _taintedTypes.has(r))) {
        _taintedTypes.add(name);
        changed = true;
      }
    }
  }
}

/** Deriving clause, dropping `Repr`/`DecidableEq` for opaque-tainted types. */
function emitDeriving(name: string, deriving: string[]): string {
  const der = _taintedTypes.has(name) ? deriving.filter(x => x !== "Repr" && x !== "DecidableEq") : deriving;
  return der.length > 0 ? `\nderiving ${der.join(", ")}` : "";
}

let _needsJSString = false;
let _needsUnknown = false;
let _unknownEmitted = false;  // across files in one run — the def file imports the types file

// Bool-vs-Prop context. Lean keeps `Bool` and `Prop` distinct; the IR uses the
// Prop connectives (∧/∨/¬) uniformly. In a computational position the connectives
// may need to be the Bool ones (&&/||/!). They are only *required* when a connective
// has an operand that does not coerce Bool→Prop — see `needsBoolConnectives`. A body
// built only from decidable atoms (comparisons, Bool-returning calls) coerces fine
// and stays in the more proof-friendly Prop form.
let _boolCtx = false;

/** Constructor names come from source strings (string-union values,
 *  discriminated-union tags) and may contain non-identifier characters
 *  ("spec-pure"); guillemet-quote those — exact and collision-free. */
function leanCtorName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'!?]*$/.test(name) ? name : `«${name}»`;
}

/** Render a match pattern to Lean syntax: `_`, a quoted literal, or `.ctor args`. */
function renderLeanPattern(p: MatchPattern): string {
  if (p.kind === "wild") return "_";
  if (p.kind === "literal") return emitExpr({ kind: "str", value: p.value });
  return "." + [leanCtorName(p.ctor), ...p.binders].join(" ");
}

// A Bool-valued atom that does NOT coerce to Prop: an inlined union discriminator
// (lowered to a match-bool `match x with | .C .. => true | _ => false`) or a raw
// `match` used as a Bool — neither has a `Decidable` instance Lean can synthesize
// through the `match`. Under a Prop connective (∧/∨/¬) such an operand is a type
// error, so its presence forces the whole body to Bool connectives.
function isNonCoercibleBoolAtom(e: Expr): boolean {
  if (e.kind === "match") return true;
  if (e.kind === "binop" && (e.op === "=" || e.op === "≠") && e.right.kind === "constructor") {
    const rhs = e.right; // capture the narrowed node so it survives the closure below
    const ctor = rhs.type ? _unionCtors.get(rhs.type)?.find(c => c.name === rhs.name) : undefined;
    return !!ctor && ctor.fields.length > 0;
  }
  return false;
}

// A ∧/∨/¬ connective with a non-coercible operand — the specific node that would
// fail to elaborate if emitted in Prop form.
function connectiveHasNonCoercibleOperand(e: Expr): boolean {
  if (e.kind === "binop" && (e.op === "∧" || e.op === "∨")) return isNonCoercibleBoolAtom(e.left) || isNonCoercibleBoolAtom(e.right);
  if (e.kind === "unop" && e.op === "¬") return isNonCoercibleBoolAtom(e.expr);
  return false;
}

// True iff some ∧/∨/¬ connective in `e` has a non-coercible operand, i.e. emitting
// the body with Prop connectives would fail to elaborate. (A decidable atom coerces,
// so a body with no such operand stays Prop — this keeps arithmetic predicates like
// `x ≥ 0 ∧ x < n` in `∧` form rather than forcing `&&`.)
function needsBoolConnectives(e: Expr): boolean {
  return anyExpr(e, connectiveHasNonCoercibleOperand);
}

function emitMethodCall(tyKind: string, method: string, monadic: boolean, obj: string, args: string[]): string {
  // Array methods
  if (tyKind === "array") {
    if (method === "map")      return `${obj}.${monadic ? "mapM" : "map"} ${args[0]}`;
    if (method === "filter")   return `${obj}.${monadic ? "filterM" : "filter"} ${args[0]}`;
    if (method === "every")    return `${obj}.${monadic ? "allM" : "all"} ${args[0]}`;
    if (method === "some")     return `${obj}.${monadic ? "anyM" : "any"} ${args[0]}`;
    if (method === "reduce" && args.length === 2) return `(${obj}.foldl ${args[0]} ${args[1]})`;
    if (method === "includes") return args.length > 1 ? `(${obj}.extract ${args[1]} ${obj}.size).contains ${args[0]}` : `${obj}.contains ${args[0]}`;
    if (method === "find")     return `${obj}.find? ${args[0]}`;
    if (method === "join")     return `(String.intercalate ${args[0]} ${obj}.toList)`;
    if (method === "with")     return `${obj}.set! ${args[0]} ${args[1]}`;
    if (method === "push")     return args.length === 1 ? `Array.push ${obj} ${args[0]}` : `${obj} ++ #[${args.join(", ")}]`;
    if (method === "unshift")  return `(#[${args.join(", ")}] ++ ${obj})`;
    if (method === "concat")   return args.length === 1 ? `Array.push ${obj} ${args[0]}` : `${obj} ++ #[${args.join(", ")}]`;
    // arr.slice → Array.extract. No-arg slice is a full copy (Array is a value
    // type in Lean, so the receiver itself); one arg drops the prefix, two args
    // give the half-open range. Matches JS for non-negative bounds (negative
    // indices are unsupported — same caveat as the Dafny backend's direct slice).
    if (method === "slice" && args.length === 0) return obj;
    if (method === "slice" && args.length === 1) return `${obj}.extract ${args[0]} ${obj}.size`;
    if (method === "slice" && args.length === 2) return `${obj}.extract ${args[0]} ${args[1]}`;
  }
  // String methods
  if (tyKind === "string") {
    _needsJSString = true;
    if (method === "indexOf") {
      if (args.length !== 1) throw new Error("Lean string.indexOf does not support a position argument");
      return `JSString.indexOf ${obj} ${args[0]}`;
    }
    if (method === "slice")   return `JSString.slice ${obj} ${args[0]} ${args[1]}`;
  }
  // Map methods
  if (tyKind === "map") {
    if (method === "get")       return `${obj}.get? ${args[0]}`;
    if (method === "getDirect") return `${obj}.get! ${args[0]}`;
    if (method === "has")       return `${obj}.contains ${args[0]}`;
    if (method === "set")       return `${obj}.insert ${args[0]} ${args[1]}`;
    if (method === "delete")    return `${obj}.erase ${args[0]}`;
  }
  // Set methods
  if (tyKind === "set") {
    if (method === "has") return `${obj}.contains ${args[0]}`;
    if (method === "add") return `${obj}.insert ${args[0]}`;
    if (method === "delete") return `${obj}.erase ${args[0]}`;
  }
  throw new Error(`Unsupported Lean method call: .${method}() on ${tyKind}`);
}

// ── Expression emission ─────────────────────────────────────

// Some Lean term forms extend their body as far as possible: `∀`/`∃` bodies,
// and `if`/`let` tails. As an operator operand they would swallow the operator
// — `(if c then 1 else 0) + r` written bare parses as `if c then 1 else (0 + r)`.
// Wrap these forms in parens so the operand is closed before the operator.
// (`match` self-parenthesizes in `emitExpr`, and other forms close via
// precedence, so neither needs wrapping here.)
function wrapOperand(sub: Expr, parentPrec?: number): string {
  const inner = emitExpr(sub, parentPrec);
  return (sub.kind === "forall" || sub.kind === "exists" ||
          sub.kind === "if" || sub.kind === "let")
    ? `(${inner})` : inner;
}

function emitExpr(e: Expr, parentPrec?: number): string {
  switch (e.kind) {
    // `undefined` is the IR's spelling of the absent optional (mirrors dafny-emit's None)
    case "var": return e.name === "undefined" ? "none" : escapeName(e.name);
    case "num": return `${e.value}`;
    // Already canonical decimal; Lean's `Int` is mathematical, so no `n` suffix.
    case "bigint": return e.value;
    case "bool": return e.value ? "true" : "false";
    case "str": return `"${e.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

    case "constructor": {
      // With type: emit `Type.name` (unambiguous; needed in expression positions
      // like `match ... | .none => Type.some x` where elaboration can't infer).
      // Without type: emit `.name` (dotted form; works in pattern positions
      // and where the expected type is clear from context).
      const head = e.type ? `${e.type}.${leanCtorName(e.name)}` : `.${leanCtorName(e.name)}`;
      if (!e.args || e.args.length === 0) return head;
      const args = e.args.map(a =>
        (a.kind === "binop" || a.kind === "unop" || a.kind === "implies" || a.kind === "app" || a.kind === "methodCall") ? `(${emitExpr(a)})` : emitExpr(a)
      );
      return `${head} ${args.join(" ")}`;
    }
    case "arrayLiteral":
      if (e.elems.length === 0) return `#[]`;
      return `#[${e.elems.map(el => emitExpr(el)).join(", ")}]`;
    case "tupleLiteral":
      return `(${e.elems.map(el => emitExpr(el)).join(", ")})`;
    case "tupleProj": {
      // Right-nested Prod projection: element i is `.2`×i then `.1`, except the
      // last (i = arity-1) which is `.2`×i with no trailing `.1`.
      const obj = emitExpr(e.obj);
      const twos = ".2".repeat(e.index);
      return e.index === e.arity - 1 ? `${obj}${twos}` : `${obj}${twos}.1`;
    }
    case "emptyMap": return `∅`;
    case "emptySet": return `∅`;
    case "default": return `(default : ${tyToLean(e.type)})`;

    case "methodCall": {
      const obj = emitExpr(e.obj);
      const wrap = e.obj.kind === "binop" || e.obj.kind === "app" || e.obj.kind === "methodCall" || e.obj.kind === "if" || e.obj.kind === "let";
      const receiver = wrap ? `(${obj})` : obj;
      // Predicate-taking array methods require a Bool-valued callback even when
      // the surrounding expression returns an array/option rather than Bool.
      // Usually Lean can coerce a decidable Prop-valued predicate. A predicate
      // containing a raw Bool match cannot be coerced through ∧/∨/¬, though, so
      // switch just that callback to computational connectives. This is local:
      // setting the enclosing definition's Bool context would incorrectly
      // affect unrelated arguments and would still miss predicates inside an
      // Array-returning definition such as `xs.filter(...)`.
      const predicateMethod = e.objTy.kind === "array" &&
        ["filter", "every", "some", "find"].includes(e.method);
      const args = e.args.map((a, i) => {
        const prevBoolCtx = _boolCtx;
        if (predicateMethod && i === 0) _boolCtx = prevBoolCtx || needsBoolConnectives(a);
        let rendered: string;
        try {
          rendered = emitExpr(a);
        } finally {
          _boolCtx = prevBoolCtx;
        }
        return (a.kind === "binop" || a.kind === "unop" || a.kind === "implies" || a.kind === "app" || a.kind === "methodCall")
          ? `(${rendered})` : rendered;
      });
      return emitMethodCall(e.objTy.kind, e.method, e.monadic, receiver, args);
    }

    case "lambda": {
      const params = e.params.map(p => p.name).join(" ");
      // Single return statement → expression lambda
      if (e.body.length === 1 && e.body[0].kind === "return") {
        return `(fun ${params} => ${emitExpr(e.body[0].value)})`;
      }
      // Multi-statement → do block
      return `(fun ${params} => do\n${emitStmts(e.body, 2)})`;
    }

    case "unop":
      if (e.op === "¬") return _boolCtx ? `!(${emitExpr(e.expr)})` : `¬(${emitExpr(e.expr)})`;
      if (e.op !== "-") throw new Error(`Unsupported Lean unary operator: ${e.op}`);
      return (e.expr.kind === "num" || e.expr.kind === "bigint")
        ? `-${e.expr.value}` : `(-${emitExpr(e.expr)})`;

    case "binop": {
      // Discriminator test against a constructor that carries fields:
      // `x = .Ctor` → `(match x with | .Ctor .. => true | _ => false)`. A
      // multi-field constructor is a function, not a value, so a bare
      // `x = Type.Ctor` is ill-typed. The Bool result coerces to Prop in spec
      // positions, mirroring how the backend already treats decidable atoms.
      // Nullary constructors (enums) keep the cheap `DecidableEq` comparison.
      if ((e.op === "=" || e.op === "≠") && e.right.kind === "constructor") {
        const rhs = e.right; // capture the narrowed node so it survives into the closure below
        const ctor = rhs.type ? _unionCtors.get(rhs.type)?.find(c => c.name === rhs.name) : undefined;
        if (ctor && ctor.fields.length > 0) {
          const [yes, no] = e.op === "=" ? ["true", "false"] : ["false", "true"];
          return `(match ${emitExpr(e.left)} with | .${leanCtorName(rhs.name)} .. => ${yes} | _ => ${no})`;
        }
      }
      // `k in m` (map/set membership) → `m.contains k` in Lean. Dafny has
      // native `in`; Lean uses the method form for HashMap/HashSet.
      if (e.op === "in") {
        const recv = emitExpr(e.right);
        const wrap = e.right.kind === "binop" || e.right.kind === "app" || e.right.kind === "methodCall";
        return `${wrap ? `(${recv})` : recv}.contains ${emitExpr(e.left)}`;
      }
      const op = e.op === "arrayConcat" ? "++"
        : _boolCtx && e.op === "∧" ? "&&"
        : _boolCtx && e.op === "∨" ? "||"
        : e.op;
      // ↔ does not chain in Lean — a nested iff operand needs parens.
      const childPrec = e.op === "↔" ? prec(e.op) + 1 : prec(e.op);
      // `-`, `/`, `%` are left-associative and non-associative, so an equal-
      // precedence right operand must be parenthesized: `a - (b - c)` would
      // otherwise emit as `a - b - c`, i.e. `(a - b) - c`.
      const rightPrec = e.op === "↔" ? childPrec
        : ["-", "/", "%"].includes(e.op) ? prec(e.op) + 1 : childPrec;
      const s = `${wrapOperand(e.left, childPrec)} ${op} ${wrapOperand(e.right, rightPrec)}`;
      return (parentPrec !== undefined && prec(e.op) < parentPrec) ? `(${s})` : s;
    }

    case "implies": {
      // Premises bind at →'s level: a nested-implication premise must keep its
      // parens (→ is right-associative, so `(a → b) → c` ≠ `a → b → c`), and
      // ↔ binds looser than → in Lean. The conclusion is the right-assoc tail,
      // where a nested implication is safe bare — only ↔ needs parens there.
      const wrapIff = (x: Expr) => x.kind === "binop" && x.op === "↔" ? `(${emitExpr(x)})` : undefined;
      const parts = [...e.premises.map(p => wrapOperand(p, prec("→"))), wrapIff(e.conclusion) ?? emitExpr(e.conclusion)];
      const s = parts.join(" → ");
      return parentPrec !== undefined ? `(${s})` : s;
    }

    case "app": {
      const args = e.args.map(a =>
        (a.kind === "binop" || a.kind === "unop" || a.kind === "implies" || a.kind === "app" || a.kind === "methodCall") ? `(${emitExpr(a)})` : emitExpr(a)
      );
      // Datatype constructor (tagged by transform): Lean needs the qualified name
      // `BaseType.variant`; a bare `variant` is an unknown identifier. (Dafny keeps
      // the bare form, so its output is unaffected.)
      if (e.ctorOf) {
        const ctor = leanCtorName(e.fn);
        return args.length ? `${e.ctorOf}.${ctor} ${args.join(" ")}` : `${e.ctorOf}.${ctor}`;
      }
      // Option constructors arrive Dafny-spelled from transform (`app "Some"`);
      // Lean core exports the lowercase forms as top-level names.
      if (e.fn === "Some" && args.length === 1) return `some ${args[0]}`;
      if (e.fn === "None" && args.length === 0) return `none`;
      // SetToSeq → .toArray for Lean (HashSet has native toArray)
      if (e.fn === "SetToSeq" && args.length === 1) return `${args[0]}.toArray`;
      if (e.fn === "SetFromSeq" && args.length === 1) return `Std.HashSet.ofList ${args[0]}.toList`;
      if (e.fn === "ToString" && args.length === 1) return `toString ${args[0]}`;
      // JSRem (JS truncated remainder) → Lean's native truncated `Int.tmod`
      if (e.fn === "JSRem" && args.length === 2) return `Int.tmod ${args[0]} ${args[1]}`;
      // JSTruncDiv (JS truncated bigint division) → Lean's native `Int.tdiv`
      if (e.fn === "JSTruncDiv" && args.length === 2) return `Int.tdiv ${args[0]} ${args[1]}`;
      // perm(a, b) → `List.Perm` on the underlying lists. Dafny lowers it to
      // `multiset(a) == multiset(b)`; the Lean image is `a.toList ~ b.toList`,
      // which mathlib's `List.Perm` provides (reflexivity, symmetry,
      // `perm_append_comm`, and `Perm.count_eq` for the count-invariance payoff).
      if (e.fn === "Perm" && args.length === 2) return `(${args[0]}.toList).Perm (${args[1]}.toList)`;
      return `${e.fn} ${args.join(" ")}`;
    }

    case "field": {
      // Union destructor (tagged by transform): `x.field` where x is a
      // multi-constructor inductive. Lean has no projection there, so match the
      // owning constructor, bind the field positionally, and ignore the rest.
      // Other constructors fall to `default` — the source guards every such
      // access with a discriminator test, so that branch is never reached.
      if (e.fromUnion) {
        const ctors = _unionCtors.get(e.fromUnion);
        // Pin the owning ctor when given (field names repeat across variants);
        // otherwise fall back to the sole variant carrying this field name.
        const owner = (e.ctor ? ctors?.find(c => c.name === e.ctor) : undefined)
          ?? ctors?.find(c => c.fields.some(f => f.name === e.field));
        if (owner) {
          const idx = owner.fields.findIndex(f => f.name === e.field);
          const pats = owner.fields.map((_, i) => (i === idx ? "_v" : "_")).join(" ");
          const fty = tyToLean(owner.fields[idx].type);
          return `(match ${emitExpr(e.obj)} with | .${leanCtorName(owner.name)} ${pats} => _v | _ => (default : ${fty}))`;
        }
      }
      const obj = emitExpr(e.obj);
      if (e.field === "collectionSize") return `${obj}.size`;
      const wrap = e.obj.kind !== "var" && e.obj.kind !== "num" && e.obj.kind !== "bigint" && e.obj.kind !== "bool";
      return wrap ? `(${obj}).${escapeName(e.field)}` : `${obj}.${escapeName(e.field)}`;
    }

    case "toNat": {
      const inner = emitExpr(e.expr);
      const wrap = e.expr.kind !== "var" && e.expr.kind !== "num" && e.expr.kind !== "bigint";
      return wrap ? `(${inner}).toNat` : `${inner}.toNat`;
    }

    case "toReal":
      // A real value reached the Lean backend via coercion (e.g. number `/`).
      // Same unsupported-real story as the `real` type case in tyToLean.
      throw new Error("real arithmetic is not supported by the Lean backend (needs noncomputable ℝ / Mathlib).");

    case "index": {
      const arr = emitExpr(e.arr);
      // Parenthesize a low-precedence array expr (e.g. a function application)
      // so the index binds to the whole thing, not its last token.
      const wrap = e.arr.kind === "app" || e.arr.kind === "binop" || e.arr.kind === "methodCall" || e.arr.kind === "if" || e.arr.kind === "let" || e.arr.kind === "unop";
      return `${wrap ? `(${arr})` : arr}[${emitExpr(e.idx)}]!`;
    }

    case "record": {
      const fields = e.fields.map(f => `${escapeName(f.name)} := ${emitExpr(f.value)}`);
      if (e.spread) return `{ ${emitExpr(e.spread)} with ${fields.join(", ")} }`;
      return `{ ${fields.join(", ")} }`;
    }

    case "if":
      return `if ${emitExpr(e.cond)} then ${emitExpr(e.then)} else ${emitExpr(e.else)}`;

    case "match": {
      // Always parenthesize inline matches — Lean parses alternatives greedily,
      // so any token after an arm body (`→`, another match's `|`, etc.) would
      // bleed into the last `.none` case without explicit bracketing.
      const arms = e.arms.map(a => `| ${renderLeanPattern(a.pattern)} => ${emitExpr(a.body)}`);
      const scrut = emitExpr(e.scrutinee);
      return `(match ${scrut} with ${arms.join(" ")})`;
    }

    case "forall": return `∀ ${e.var} : ${tyToLean(e.type)}, ${emitExpr(e.body)}`;
    case "exists": return `∃ ${e.var} : ${tyToLean(e.type)}, ${emitExpr(e.body)}`;

    case "let": return `let ${e.name} := ${emitExpr(e.value)}\n${emitExpr(e.body)}`;
    default: throw new Error(`Unsupported Lean expression: ${(e as Expr).kind}`);
  }
}

/** True if the IR expression emits to a Prop-valued Lean term. `transformExpr`
 *  routes TS comparisons/logicals through `OP_MAP` (`===`→`=`, `&&`→`∧`, `!`→`¬`)
 *  so these top-level ops land in Prop. `in` stays Bool (emits `.contains`), and
 *  bare method calls / vars / field accesses remain at their declared type. */
function isPropValued(e: Expr): boolean {
  switch (e.kind) {
    case "binop":
      return ["=", "≠", "≥", "≤", ">", "<", "∧", "∨"].includes(e.op);
    case "unop":
      return e.op === "¬";
    case "implies":
    case "forall":
    case "exists":
      return true;
    default:
      return false;
  }
}

// ── Statement emission ──────────────────────────────────────

function emitStmts(stmts: Stmt[], indent: number): string {
  const pad = "  ".repeat(indent);
  return stmts.map(s => emitStmt(s, indent)).join("\n");
}

function emitStmt(s: Stmt, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (s.kind) {
    case "let": {
      // `mut` lets always carry their type (assignments must re-elaborate at it).
      // Immutable lets are ascribed only when the initializer is a `match` (the
      // `??` / Option-unwrap lowerings): Velvet's WP elaboration runs *backwards*,
      // so without the ascription the binding's type is a metavariable that a
      // later use pins first — e.g. `lines.size ≤ maxLines` pins `maxLines : ℕ`
      // and the ℤ-valued unwrap arms then fail to elaborate. Other initializer
      // shapes determine their own type, and leaving them bare keeps previously
      // generated (and proven) artifacts byte-stable.
      const ascribe = s.mutable || s.value.kind === "match";
      const ty = ascribe && s.type.kind !== "unknown" ? ` : ${tyToLean(s.type)}` : "";
      return `${pad}let ${s.mutable ? "mut " : ""}${escapeName(s.name)}${ty} := ${emitExpr(s.value)}`;
    }
    case "assign": return `${pad}${escapeName(s.target)} := ${emitExpr(s.value)}`;
    case "ghostLet":
      return `${pad}let mut ${escapeName(s.name)} : ${tyToLean(s.type)} := ${emitExpr(s.value)}`;
    case "ghostAssign": return `${pad}${escapeName(s.target)} := ${emitExpr(s.value)}`;
    case "assert": {
      if (s.assumed) throw new Error("//@ assume: not supported in Lean backend.");
      // WPGen.assert needs a Prop; bare Bool expressions (`k in m` → `.contains`,
      // method calls, vars) lack a matching WPGen instance and silently fall back
      // to WPGen.default, which drops the assertion. Coerce to Prop via `= true`.
      // Top-level Prop constructs (`=`, `<`, `∧`, `¬`, `∀`, `∃`, `→`) already
      // land in Prop — Lean auto-coerces inner Bools there.
      const prevBoolCtx = _boolCtx;
      _boolCtx = false; // assertions are Prop
      const inner = emitExpr(s.expr);
      _boolCtx = prevBoolCtx;
      const wrapped = isPropValued(s.expr) ? inner : `(${inner}) = true`;
      return `${pad}assertGadget (${wrapped})`;
    }
    case "bind": return `${pad}${escapeName(s.target)} ← ${emitExpr(s.value)}`;
    case "let-bind": return `${pad}let ${s.name} ← ${emitExpr(s.value)}`;
    case "return": return `${pad}return ${emitExpr(s.value)}`;
    case "break": return `${pad}break`;
    case "continue": return `${pad}continue`;

    case "if": {
      let out = `${pad}if ${emitExpr(s.cond)} then\n${emitStmts(s.then, indent + 1)}`;
      if (s.else.length > 0) {
        if (s.else.length === 1 && s.else[0].kind === "if") {
          const ei = s.else[0];
          out += `\n${pad}else if ${emitExpr(ei.cond)} then\n${emitStmts(ei.then, indent + 1)}`;
          if (ei.else.length > 0) out += `\n${pad}else\n${emitStmts(ei.else, indent + 1)}`;
        } else {
          out += `\n${pad}else\n${emitStmts(s.else, indent + 1)}`;
        }
      }
      return out;
    }

    case "match": {
      const scrut = emitExpr(s.scrutinee);
      // Option match (.some/.none) → emit as if/let for WPGen.if compatibility
      if (s.arms.length === 2) {
        const someArm = s.arms.find(a => a.pattern.kind === "ctor" && a.pattern.ctor === "some");
        const noneArm = s.arms.find(a => a.pattern.kind === "ctor" && a.pattern.ctor === "none");
        if (someArm && noneArm) {
          const boundVar = patternBinders(someArm.pattern)[0]; // ".some x" ⇒ "x"
          const hName = `h_${scrut.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          const lines = [
            `${pad}if ${hName} : (${scrut}).isSome = true then`,
            `${pad}  let ${boundVar} := (${scrut}).get ${hName}`,
          ];
          if (someArm.body.length === 0) {
            lines.push(`${pad}  pure ()`);
          } else {
            lines.push(emitStmts(someArm.body, indent + 1));
          }
          lines.push(`${pad}else`);
          if (noneArm.body.length === 0) {
            lines.push(`${pad}  pure ()`);
          } else {
            lines.push(emitStmts(noneArm.body, indent + 1));
          }
          return lines.join("\n");
        }
      }
      // General match
      const lines = [`${pad}match ${scrut} with`];
      for (const arm of s.arms) {
        lines.push(`${pad}| ${renderLeanPattern(arm.pattern)} =>`);
        if (arm.body.length === 0) {
          lines.push(`${pad}  pure ()`);
        } else {
          lines.push(emitStmts(arm.body, indent + 1));
        }
      }
      return lines.join("\n");
    }

    case "while": {
      // Guard is computational (Bool); invariants / done_with are Prop.
      const lines = [`${pad}while ${emitExpr(s.cond)}`];
      const prevBoolCtx = _boolCtx;
      _boolCtx = false;
      for (const inv of s.invariants) lines.push(`${pad}  invariant invariant_${++_invariantIndex}: (${emitExpr(inv)} : Prop)`);
      if (s.decreasing) lines.push(`${pad}  decreasing ${emitExpr(s.decreasing)}`);
      if (s.doneWith) lines.push(`${pad}  done_with (${emitExpr(s.doneWith)} : Prop)`);
      _boolCtx = prevBoolCtx;
      lines.push(`${pad}do`);
      lines.push(emitStmts(s.body, indent + 1));
      return lines.join("\n");
    }

    case "forin": {
      // Velvet 2 needs an explicit exit assertion when invariants use the cursor.
      // Preserve the range endpoint used by the old rule, including on `break`.
      const stop = freshName(`_rangeStop${_rangeIndex++}`);
      const idx = escapeName(s.idx);
      const lines = [`${pad}let ${stop} : Nat := ${emitExpr(s.bound)}`,
        `${pad}for ${idx} in [:${stop}]`];
      const prevBoolCtx = _boolCtx;
      _boolCtx = false;
      const invariants = s.invariants.map(inv => `(${emitExpr(inv)} : Prop)`);
      for (const inv of invariants)
        lines.push(`${pad}  invariant invariant_${++_invariantIndex}: ${inv}`);
      if (invariants.length > 0)
        lines.push(`${pad}  done_with (let ${idx} : Nat := ${stop}; ${invariants.join(" ∧ ")})`);
      _boolCtx = prevBoolCtx;
      lines.push(`${pad}do`);
      lines.push(`${pad}  let ${idx} : Nat := ${idx}`);
      lines.push(emitStmts(s.body, indent + 1));
      return lines.join("\n");
    }
  }
}

// ── Declaration emission ─────────────────────────────────────

/** Collect every function/variable name an IR tree references (stripping any
 *  `Pure.` qualifier), via a generic walk over `app`/`var` nodes. */
function collectRefNames(node: unknown, into: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectRefNames(x, into); return; }
  const n = node as { kind?: string; fn?: unknown; name?: unknown };
  if (n.kind === "app" && typeof n.fn === "string") into.add(n.fn.replace(/^Pure\./, ""));
  if (n.kind === "var" && typeof n.name === "string") into.add(n.name.replace(/^Pure\./, ""));
  for (const k of Object.keys(node)) collectRefNames((node as Record<string, unknown>)[k], into);
}

/** Lean requires definition-before-use: order sibling decls so one that
 *  references another is emitted after it. Cycles are left in place (they would
 *  need a `mutual` block). Bails to the original order if any decl is unnamed. */
function orderDeclsByDeps(decls: Decl[]): Decl[] {
  const named = decls.filter((d): d is Decl & { name: string } => typeof (d as { name?: unknown }).name === "string");
  if (named.length !== decls.length) return decls;
  const names = new Set(named.map(d => d.name));
  const byName = new Map(named.map(d => [d.name, d]));
  const deps = new Map<string, string[]>();
  for (const d of named) {
    const refs = new Set<string>();
    collectRefNames(d, refs);
    refs.delete(d.name);
    deps.set(d.name, [...refs].filter(r => names.has(r)));
  }
  const sorted: Decl[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name) || onStack.has(name)) return;
    onStack.add(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    onStack.delete(name);
    done.add(name);
    const def = byName.get(name);
    if (def) sorted.push(def);
  };
  for (const d of named) visit(d.name);
  return sorted;
}

function emitDecl(d: Decl): string {
  switch (d.kind) {
    case "inductive": {
      const lines = [`inductive ${d.name} where`];
      for (const c of d.constructors) {
        if (c.fields.length === 0) {
          lines.push(`  | ${leanCtorName(c.name)} : ${d.name}`);
        } else {
          const params = c.fields.map(f => `(${escapeName(f.name)} : ${tyToLean(f.type)})`).join(" ");
          lines.push(`  | ${leanCtorName(c.name)} ${params} : ${d.name}`);
        }
      }
      return lines.join("\n") + emitDeriving(d.name, d.deriving);
    }

    case "structure": {
      const lines = [`structure ${d.name} where`];
      for (const f of d.fields) lines.push(`  ${escapeName(f.name)} : ${tyToLean(f.type)}`);
      return lines.join("\n") + emitDeriving(d.name, d.deriving);
    }

    case "type-alias": {
      return `abbrev ${d.name} := ${tyToLean(d.target)}`;
    }

    case "opaque-type": {
      // Abstract type — no definition. Never constructed or destructured.
      return `opaque ${d.name} : Type`;
    }

    case "def": {
      const params = d.params.map(p => `(${escapeName(p.name)} : ${tyToLean(p.type)})`).join(" ");
      // A Bool-returning pure function is a computation, not a proposition, so its
      // connectives *may* need the Bool operators (&&/||/!) — but only when a
      // connective has a non-coercible operand (e.g. an inlined union discriminator).
      // A predicate built from decidable atoms (`x ≥ 0 ∧ x < n`) coerces to Bool as
      // a whole and stays in the more proof-friendly Prop form. Other return types
      // only have connectives inside (Decidable) conditions, where Prop is fine.
      const prevBoolCtx = _boolCtx;
      _boolCtx = tyToLean(d.returnType) === "Bool" && needsBoolConnectives(d.body);
      const body = emitPureExpr(d.body, 1);
      _boolCtx = prevBoolCtx;
      let out = `def ${d.name} ${params} : ${tyToLean(d.returnType)} :=\n${body}`;
      // A `//@ decreases` on a pure function marks it recursive and names its
      // termination measure — emit it as Lean's `termination_by`. This is
      // required when the recursion is on `arr.slice(...)` (→ `Array.extract`,
      // which Lean cannot see as a structural subterm); for a bare-Nat counter
      // Lean could infer structural recursion on its own, but honoring the
      // clause uniformly is simpler and harmless. Lean's default `decreasing_by`
      // discharges the goal in both cases (it knows `Array.size_extract`), so no
      // explicit tactic is needed.
      if (d.decreases) out += `\ntermination_by ${emitExpr(d.decreases)}`;
      return out;
    }

    case "def-by-method":
      throw new Error("function by method is not supported for Lean backend");

    case "method": {
      const params = d.params.map(p => `(${escapeName(p.name)} : ${tyToLean(p.type)})`).join(" ");
      // Spec clauses are Prop; the `do` body is computational (Bool).
      const prevBoolCtx = _boolCtx;
      _boolCtx = false;
      // Prime the return binder only on a collision within *this method's own*
      // signature/body — `res` is a common identifier module-wide (record
      // fields, unrelated params), so a module-wide check would prime spuriously.
      _resultName = freshNameWhere("res", n =>
        d.params.some(p => escapeName(p.name) === n) ||
        usesNameInDecl(d.requires, d.ensures, d.body, n));
      _invariantIndex = 0;
      _rangeIndex = 0;
      const lines = [`method ${d.name} ${params} returns (${_resultName} : ${tyToLean(d.returnType)})`];
      d.requires.forEach((r, i) => lines.push(`  requires require_${i + 1}: (${emitExpr(r)} : Prop)`));
      d.ensures.forEach((e, i) => lines.push(`  ensures ensures_${i + 1}: (${emitExpr(e)} : Prop)`));
      lines.push("  do");
      _boolCtx = true;
      lines.push(emitStmts(d.body, 2));
      _boolCtx = prevBoolCtx;
      return lines.join("\n");
    }

    case "namespace": {
      const lines = [`namespace ${d.name}`];
      for (const inner of orderDeclsByDeps(d.decls)) lines.push("", emitDecl(inner));
      lines.push("", `end ${d.name}`);
      return lines.join("\n");
    }

    case "class":
      throw new Error(`Lean class support not yet implemented: ${d.name}`);

    case "const":
      return `def ${escapeName(d.name)} : ${tyToLean(d.type)} := ${emitExpr(d.value)}`;

    case "extern": {
      if (d.impure) {
        throw new Error(
          "impure extern is not supported in the Lean backend; add //@ pure to this extern or use extern-default: pure",
        );
      }
      // Mirror Dafny's `function {:axiom}`: an uninterpreted total function.
      // In Lean that is an `opaque` declaration (sound — it commits to no body,
      // only to the type being inhabited). Any `requires`/`ensures` the source
      // carried become a characterizing `axiom`; `\result` was already replaced
      // by the call expression in the transform, so ensures reference `name args`.
      const tp = d.typeParams.length > 0 ? ` {${d.typeParams.join(" ")} : Type}` : "";
      const params = d.params.map(p => `(${escapeName(p.name)} : ${tyToLean(p.type)})`).join(" ");
      const sig = `opaque ${escapeName(d.name)}${tp}${params ? ` ${params}` : ""} : ${tyToLean(d.returnType)}`;
      if (d.requires.length === 0 && d.ensures.length === 0) return sig;
      // Spec axiom: ∀ params, req1 → … → (ens1 ∧ … ∧ ensN). Tagged `@[grind]` so
      // the proof automation can use it, matching the ghost-function convention.
      // Parenthesize each clause: an unwrapped `∀ k, P` would otherwise swallow
      // the following ` ∧ …` conjuncts into its body.
      const hyps = d.requires.map(e => `(${emitExpr(e)})`);
      const concl = d.ensures.map(e => `(${emitExpr(e)})`).join(" ∧ ");
      const axBody = [...hyps, concl].join(" → ");
      const axiom = `@[grind] axiom ${escapeName(d.name)}_spec${params ? ` ${params}` : ""} : ${axBody}`;
      return `${sig}\n${axiom}`;
    }
  }
}

/** Emit a pure expression with indented if/match blocks. */
function emitPureExpr(e: Expr, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (e.kind) {
    case "if":
      return `${pad}if ${emitExpr(e.cond)} then\n${emitPureExpr(e.then, indent + 1)}\n${pad}else\n${emitPureExpr(e.else, indent + 1)}`;
    case "match": {
      const lines = [`${pad}match ${emitExpr(e.scrutinee)} with`];
      for (const arm of e.arms) {
        lines.push(`${pad}| ${renderLeanPattern(arm.pattern)} =>`);
        lines.push(emitPureExpr(arm.body, indent + 1));
      }
      return lines.join("\n");
    }
    case "let":
      return `${pad}let ${e.name} := ${emitExpr(e.value)}\n${emitPureExpr(e.body, indent)}`;
    default:
      return `${pad}${emitExpr(e)}`;
  }
}

// ── File emission ────────────────────────────────────────────

/** Reset per-module emitter state. Call once per module before the types file
 *  (not between types and def — the def file reads the types file's registries). */
export function resetLeanModule(): void {
  _resultName = "res";
  _unionCtors.clear();
  _opaqueNames.clear();
  _opaqueNames.add("Unknown");
  _typeRefs.clear();
  _taintedTypes.clear();
  _needsJSString = false;
  _needsUnknown = false;
  _unknownEmitted = false;
  _boolCtx = false;
}

export function emitLeanFile(file: Module): string {
  _needsJSString = false;
  _needsUnknown = false;
  registerInductives(file.decls);
  // Emit declarations first so _needsJSString / _needsUnknown are set
  const declLines: string[] = [];
  for (const decl of file.decls) {
    declLines.push("");
    declLines.push(emitDecl(decl));
  }
  // The `unknown` carrier must precede every use (Lean is definition-before-use).
  if (_needsUnknown && !_unknownEmitted) {
    declLines.unshift("", "/-- Opaque carrier for `unknown`-typed values (mirrors Dafny's `type Unknown(==, 0)`). -/", "opaque Unknown : Type");
    _unknownEmitted = true;
  }
  const lines: string[] = [];
  if (file.comment) {
    lines.push("/-");
    lines.push(file.comment);
    lines.push("-/");
  }
  for (const imp of file.imports) lines.push(`import ${imp}`);
  if (_needsJSString && !file.imports.includes("LemmaScript.JSString"))
    lines.push("import LemmaScript.JSString");
  if (file.options.length > 0) lines.push("");
  for (const opt of file.options) lines.push(`set_option ${opt.key} ${opt.value}`);
  lines.push(...declLines);
  return lines.join("\n") + "\n";
}
