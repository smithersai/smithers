/**
 * narrow — Structural-narrowing rewrite pass.
 *
 * Pipeline: resolve → narrow → transform → emit.
 *
 * Positional drivers over condition-facts (DESIGN_LS_IN_LS.md §4): the
 * *semantics* of conditions — what a check establishes, `&&`/`||`-chain
 * analysis, binder minting, discriminant detection — live in
 * `condition-facts.ts`; this pass owns *where* a condition sits (if
 * statement, early return + rest consumption, ternary, implication, guard
 * statement, conditional initializer, nullish/optional chains, discriminant
 * chains) and rewrites each position into `someMatch` / `tagMatch` IR via
 * the shared materializers.
 *
 * Following TS semantics, narrowing rules only fire for pure access paths
 * (`var(x)` or `field(purePath, name)`). Complex scrutinees (call results,
 * index ops) require bind-first: `const v = m.get(k); if (v !== undefined) ...`.
 * The `optChain` rule is the exception: narrow constructs the someBody to use the
 * binder directly, so any scrutinee shape is allowed.
 *
 * Transform lowers `someMatch` to IR `match` Some/None, substituting the
 * binder for path-shaped scrutinees via `replacePathInTExpr` /
 * `replacePathInTStmts`. Resolve runs before narrow and handles type narrowing
 * only (env extension, `narrowedPaths`). Narrow doesn't substitute on raw IR
 * — the body keeps its original expressions until transform.
 *
 * Walker shape: bottom-up over TExpr/TStmt. At each node, recurse children
 * via the *Recurse* helpers, then try the rules in order. List-level rules
 * (early-return, let-cond) run in `walkStmts` so they can consume the rest
 * of the block. Rule order matters — see the comments at the two dispatch
 * chains.
 *
 * State is explicit (§6.1): a `CondCtx` (type declarations + optChain
 * binder counter) threads through the walk; no module-level state.
 */

import type { TModule, TFunction, TStmt, TExpr } from "./typedir.js";
import { isTerminatorKind } from "./typedir.js";
import { builtinSpec } from "./builtins.js";
import {
  type CondCtx, type PresentFact, type NoneDetector,
  presentFact, leadingPresent, leadingIsArray, flattenOr, noneDetector,
  bindPresentFact, freshPathBinder, binderHintForMapAccess, freshOcBinder,
  applyChain, restoreDiscriminantFlag, arrayBoundsCond, exprEqual,
  isArrayFact, typeofStringFact, variantFact, negVariantFact,
  presentMatchStmts, presentMatchExpr,
} from "./condition-facts.js";

// ── Walkers ──────────────────────────────────────────────────

function walkExpr(e: TExpr, ctx: CondCtx): TExpr {
  const r = recurseExpr(e, ctx);
  return ruleNullish(r, ctx) ?? ruleNullishIndex(r) ?? ruleOptChainIndex(r) ?? ruleOptChain(r, ctx) ?? ruleImplOptional(r, ctx) ?? ruleImplArrayIsArray(r, ctx) ?? ruleConditionalArrayIsArray(r, ctx) ?? ruleConditionalAndArrayIsArray(r, ctx) ?? ruleConditionalAndOptional(r, ctx) ?? ruleConditionalOptionalSimple(r, ctx) ?? ruleConditionalInMap(r, ctx) ?? ruleConditionalOptionalTruthy(r, ctx) ?? r;
}

function recurseExpr(e: TExpr, ctx: CondCtx): TExpr {
  const re = (x: TExpr) => walkExpr(x, ctx);
  switch (e.kind) {
    case "var": case "num": case "bigint": case "str": case "bool":
    case "havoc":
      return e;
    case "binop": return { ...e, left: re(e.left), right: re(e.right) };
    case "unop": return { ...e, expr: re(e.expr) };
    case "call": return { ...e, fn: re(e.fn), args: e.args.map(re) };
    case "index": return { ...e, obj: re(e.obj), idx: re(e.idx) };
    case "field": return { ...e, obj: re(e.obj) };
    case "record": return { ...e, spread: e.spread ? re(e.spread) : null,
      fields: e.fields.map(f => ({ ...f, value: re(f.value) })) };
    case "arrayLiteral": return { ...e, elems: e.elems.map(re) };
    case "lambda": return { ...e, body: walkStmts(e.body, ctx) };
    case "conditional": return { ...e, cond: re(e.cond), then: re(e.then), else: re(e.else) };
    case "optChain": return { ...e, obj: re(e.obj),
      chain: e.chain.map(s => s.kind === "call" ? { ...s, args: s.args.map(re) }
        : s.kind === "index" ? { ...s, idx: re(s.idx) }
        : s) };
    case "nullish": return { ...e, left: re(e.left), right: re(e.right) };
    case "forall": return { ...e, body: re(e.body) };
    case "exists": return { ...e, body: re(e.body) };
    case "someMatch": return { ...e, someBody: re(e.someBody), noneBody: re(e.noneBody) };
    case "tagMatch": return { ...e, scrutinee: re(e.scrutinee),
      cases: e.cases.map(c => ({ ...c, body: re(c.body) })),
      fallthrough: e.fallthrough ? re(e.fallthrough) : null };
  }
}

function walkStmt(s: TStmt, ctx: CondCtx): TStmt {
  // Recurse into children first, then try rules at this node.
  const r = recurseStmt(s, ctx);
  // Optional narrowing fires before Array.isArray narrowing: in a chain like
  // `next && Array.isArray(next.content)` the optional check must unwrap `next`
  // *outside* the array match, since `next.content` is unreachable until then.
  // (When the chain has no leading optional, ruleIfAndOptional no-ops and the
  // array rule fires; independent narrows commute, so the order is harmless.)
  // && rules fire before the simple rule because they produce nested ifs whose
  // inner shape doesn't match the simple rule directly.
  return ruleIfAndOptional(r, ctx) ?? ruleIfAndArrayIsArray(r, ctx) ?? ruleIfOptionalSimple(r, ctx) ?? ruleExprStmtAndOptional(r, ctx) ?? ruleOptionalIndexBinding(r) ?? r;
}

function walkStmts(stmts: TStmt[], ctx: CondCtx): TStmt[] {
  const result: TStmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const rest = stmts.slice(i + 1);
    // Discriminant rules consume a prefix of stmts; remaining is processed normally.
    const tagged = ruleDiscriminantChain(stmts.slice(i), ctx) ?? ruleDiscriminantNegEarlyReturn(stmts.slice(i), ctx);
    if (tagged) {
      result.push(walkStmt(tagged.stmt, ctx));
      i += tagged.consumed - 1;
      continue;
    }
    const consumed = ruleEarlyReturnOrChain(s, rest, ctx) ?? ruleEarlyReturnConsume(s, rest, ctx) ?? ruleEarlyReturnOptChainCompare(s, rest, ctx);
    if (consumed) {
      result.push(walkStmt(consumed, ctx));
      return result;
    }
    // walkStmt first — narrow's expression rules may rewrite the let init from
    // `conditional` to `someMatch`, in which case the let-cond desugar shouldn't fire.
    const walked = walkStmt(s, ctx);
    const expanded = ruleLetCondAndOptional(walked, ctx);
    if (expanded) {
      for (const x of expanded) result.push(walkStmt(x, ctx));
      continue;
    }
    result.push(walked);
  }
  return result;
}

function recurseStmt(s: TStmt, ctx: CondCtx): TStmt {
  const re = (x: TExpr) => walkExpr(x, ctx);
  const rs = (x: TStmt[]) => walkStmts(x, ctx);
  switch (s.kind) {
    case "let": return { ...s, init: re(s.init) };
    case "assign": return { ...s, value: re(s.value) };
    case "return": return { ...s, value: re(s.value) };
    case "break": case "continue": case "throw": return s;
    case "expr": return { ...s, expr: re(s.expr) };
    case "if": return { ...s, cond: re(s.cond), then: rs(s.then), else: rs(s.else) };
    case "while": return { ...s, cond: re(s.cond),
      invariants: s.invariants.map(re),
      decreases: s.decreases ? re(s.decreases) : null,
      doneWith: s.doneWith ? re(s.doneWith) : null,
      body: rs(s.body) };
    case "switch": return { ...s, expr: re(s.expr),
      cases: s.cases.map(c => ({ ...c, body: rs(c.body) })),
      defaultBody: rs(s.defaultBody) };
    case "forof": return { ...s, iterable: re(s.iterable),
      invariants: s.invariants.map(re),
      doneWith: s.doneWith ? re(s.doneWith) : null,
      body: rs(s.body) };
    case "ghostLet": return { ...s, init: re(s.init) };
    case "ghostAssign": return { ...s, value: re(s.value) };
    case "assert": return { ...s, expr: re(s.expr) };
    case "someMatch": return { ...s, someBody: rs(s.someBody), noneBody: rs(s.noneBody) };
    case "tagMatch": return { ...s, scrutinee: re(s.scrutinee),
      cases: s.cases.map(c => ({ ...c, body: rs(c.body) })),
      fallthrough: rs(s.fallthrough) };
  }
}

function isTerminating(stmts: TStmt[]): boolean {
  if (stmts.length === 0) return false;
  return isTerminatorKind(stmts[stmts.length - 1].kind);
}

// ── Presence drivers ────────────────────────────────────────

/** Driver: `if (e !== undefined) then else` — presence fact in if position.
 *  → `someMatch e { Some(_e_val) => then, None => else }`. Requires a
 *  non-empty Some branch. */
function ruleIfOptionalSimple(s: TStmt, ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  const check = presentFact(s.cond);
  if (!check) return null;
  const someBody = check.negated ? s.else : s.then;
  const noneBody = check.negated ? s.then : s.else;
  if (someBody.length === 0) return null;
  return presentMatchStmts(check, someBody, noneBody, ctx);
}

/** Driver: `if (e === undefined) terminate; rest` — presence fact in
 *  early-return position, consuming the rest of the block into the
 *  narrowed scope. Fires when the Some branch is empty. */
function ruleEarlyReturnConsume(s: TStmt, rest: TStmt[], ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  if (rest.length === 0) return null;
  const check = presentFact(s.cond);
  if (!check) return null;
  const someBranch = check.negated ? s.else : s.then;
  const noneBranch = check.negated ? s.then : s.else;
  if (someBranch.length !== 0) return null;
  if (!isTerminating(noneBranch)) return null;
  return presentMatchStmts(check, rest, noneBranch, ctx);
}

/** Driver: `if (D1 || … || Dn) terminate; rest` — De-Morgan position. Each `Di`
 *  that detects some optional `x` is None (`!x`, `x === undefined`,
 *  `x?.chain !== lit`) narrows that `x` to Some across `rest`; the rest —
 *  value guards reading a narrowed `x` directly, plus the detectors' Some-case
 *  residuals — become a trailing early-return. Sound: reaching `rest` means
 *  every disjunct was false, so every detected optional is present. */
function ruleEarlyReturnOrChain(s: TStmt, rest: TStmt[], ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  if (rest.length === 0) return null;
  if (s.then.length === 0 || s.else.length !== 0 || !isTerminating(s.then)) return null;
  if (s.cond.kind !== "binop" || s.cond.op !== "||") return null;  // single check is the simpler rule
  const leaves = flattenOr(s.cond);
  if (leaves.length < 2) return null;

  const detectors: NoneDetector[] = [];
  const residualLeaves: TExpr[] = [];
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const d = noneDetector(leaf, ctx);
    if (!d) { residualLeaves.push(leaf); continue; }
    const key = d.binder;  // memoized by full path, not by the ambiguous hint
    if (seen.has(key)) return null;  // two detectors on one optional: rare; leave to other rules
    seen.add(key);
    detectors.push(d);
    if (d.residual) residualLeaves.push(d.residual);
  }
  if (detectors.length === 0) return null;

  let inner: TStmt[] = residualLeaves.length === 0
    ? rest
    : [{ kind: "if", cond: residualLeaves.reduce((a, b): TExpr => ({ kind: "binop", op: "||", left: a, right: b, ty: { kind: "bool" } })), then: s.then, else: [] }, ...rest];
  for (let i = detectors.length - 1; i >= 0; i--) {
    const d = detectors[i]!;
    inner = [{ kind: "someMatch", scrutinee: d.scrutinee, binderTy: d.innerTy, binder: d.binder, someBody: inner, noneBody: s.then }];
  }
  return inner[0];
}

/** Driver: `if (opt?.chain !== lit) terminate; rest` — bound-optional
 *  early-return. `opt?.chain` is `undefined` when `opt` is None, and
 *  `undefined !== lit` is true, so the None case takes the terminating branch —
 *  falling through to `rest` proves `opt` is Some. Rewrite to
 *    someMatch opt { Some(v) => [if (v.chain !== lit) terminate; rest]; None => terminate }
 *  narrowing `opt` to `v` across `rest` and handing the now-non-optional inner
 *  guard to the ordinary rules (e.g. discriminant narrowing). Restricted to
 *  `!==` so the None case is guaranteed to terminate. */
function ruleEarlyReturnOptChainCompare(s: TStmt, rest: TStmt[], ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  if (rest.length === 0) return null;
  if (s.else.length !== 0 || !isTerminating(s.then)) return null;
  const c = s.cond;
  if (c.kind !== "binop" || c.op !== "!==") return null;
  const oc = c.left.kind === "optChain" ? c.left : c.right.kind === "optChain" ? c.right : null;
  if (!oc || oc.kind !== "optChain" || oc.obj.ty.kind !== "optional") return null;
  const lit = c.left === oc ? c.right : c.left;
  const innerTy = oc.obj.ty.inner;
  const binder = freshPathBinder(oc.obj, ctx);
  if (binder === null) return null;
  const binderVar: TExpr = { kind: "var", name: binder, ty: innerTy };
  const unwrapped = applyChain(binderVar, oc.chain);
  restoreDiscriminantFlag(unwrapped, ctx.decls);
  const innerGuard: TExpr = { kind: "binop", op: "!==", left: unwrapped, right: lit, ty: { kind: "bool" } };
  // Keep `rest` as trailing statements (not an else branch) — `s.then` terminates,
  // so `if (g) terminate; rest` ≡ `if (g) terminate else rest`, and the trailing
  // form lets the ordinary early-exit rules (e.g. discriminant narrowing) fire on
  // the now-non-optional inner guard when `chain` is a union discriminant.
  const someBody: TStmt[] = [{ kind: "if", cond: innerGuard, then: s.then, else: [] }, ...rest];
  return { kind: "someMatch", scrutinee: oc.obj, binder, binderTy: innerTy, someBody, noneBody: s.then };
}

/** Driver (expression): `e !== undefined ? a : b` — presence fact in
 *  ternary position. */
function ruleConditionalOptionalSimple(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  const check = presentFact(e.cond);
  if (!check) return null;
  const someBody = check.negated ? e.else : e.then;
  const noneBody = check.negated ? e.then : e.else;
  return presentMatchExpr(check, someBody, noneBody, e.ty, ctx);
}

/** Driver (expression): `(path !== undefined [&& rest]) ==> B` — presence
 *  fact in implication position (spec premises). The premise's optional
 *  checks bind narrowed values that the conclusion can use.
 *  → `someMatch path { Some(_p_val) => (rest ==> B), None => true }`.
 *  Walks the inner ==> recursively so chained checks become nested
 *  someMatches. Spec form: no falsy gate (historical shape — presence
 *  suffices in the premise). */
function ruleImplOptional(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "binop" || e.op !== "==>") return null;
  let check: PresentFact;
  let restCond: TExpr | null = null;
  const extracted = leadingPresent(e.left);
  if (extracted) {
    check = extracted.check;
    restCond = extracted.restCond;
  } else {
    const c = presentFact(e.left);
    if (!c || c.negated) return null;
    check = c;
  }
  const innerBody: TExpr = restCond
    ? { kind: "binop", op: "==>", left: restCond, right: e.right, ty: { kind: "bool" } }
    : e.right;
  check = bindPresentFact(check, ctx);
  return {
    kind: "someMatch",
    scrutinee: check.scrutinee, binderTy: check.innerTy,
    binder: check.binder,
    someBody: walkExpr(innerBody, ctx),
    noneBody: { kind: "bool", value: true, ty: { kind: "bool" } },
    ty: { kind: "bool" },
  };
}

/** Driver (expression): `left ?? right` — nullish coalescing.
 *  → `someMatch left { Some(_v) => _v, None => right }`.
 *  Single-evaluation: scrutinee may be any expression. Presence-only
 *  semantics (`??` tests null/undefined, not falsiness) — no falsy gate. */
function ruleNullish(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "nullish") return null;
  if (e.left.ty.kind !== "optional") return null;
  const innerTy = e.left.ty.inner;
  const binder = freshOcBinder(ctx);
  return {
    kind: "someMatch",
    scrutinee: e.left, binder, binderTy: innerTy,
    someBody: { kind: "var", name: binder, ty: innerTy },
    noneBody: e.right,
    ty: e.ty,
  };
}

/** Driver (expression): `arr[i] ?? right` — in-bounds fact in nullish
 *  position. Under noUncheckedIndexedAccess `arr[i]` is `T | undefined`,
 *  undefined exactly when out of bounds, so
 *  → `(0 <= i && i < arr.length) ? arr[i] : right`. The guarded `then`
 *  keeps the seq index in bounds for the backend. (Map index is already
 *  optional-typed and handled by ruleNullish above.) */
function ruleNullishIndex(e: TExpr): TExpr | null {
  if (e.kind !== "nullish") return null;
  if (e.left.kind !== "index") return null;
  if (e.left.obj.ty.kind !== "array") return null;
  const cond = arrayBoundsCond(e.left.obj, e.left.idx);
  return { kind: "conditional", cond, then: e.left, else: e.right, ty: e.ty };
}

/** Driver (expression): `arr[i]?.<chain>` — in-bounds fact in optChain
 *  position, the optChain sibling of ruleNullishIndex.
 *  → `(0 <= i && i < arr.length) ? <chain on arr[i]> : undefined`. The
 *  conditional's optional type makes transform wrap the in-bounds chain
 *  result in Some and the OOB branch in None. (ruleOptChain itself bails
 *  here: an array index is typed as the non-optional element type.) */
function ruleOptChainIndex(e: TExpr): TExpr | null {
  if (e.kind !== "optChain") return null;
  if (e.obj.kind !== "index") return null;
  if (e.obj.obj.ty.kind !== "array") return null;
  const cond = arrayBoundsCond(e.obj.obj, e.obj.idx);
  const body = applyChain(e.obj, e.chain); // arr[i] — in bounds under `cond`
  const undef: TExpr = { kind: "var", name: "undefined", ty: { kind: "void" } };
  return { kind: "conditional", cond, then: body, else: undef, ty: e.ty };
}

/** Driver (statement): reconcile a `const e = arr[i]` whose binding is optional
 *  (`e: T | undefined`) but whose array-index initializer is total (`T`) —
 *  in-bounds fact in initializer position. Model the index as its JS
 *  semantics — `e := inBounds ? arr[i] : undefined` — so `e` is a real
 *  `Option<T>` and a later `e?.f` someMatch is well-typed; an in-bounds proof
 *  makes the None branch dead. Skipped when the element type is already
 *  optional: no mismatch. */
function ruleOptionalIndexBinding(s: TStmt): TStmt | null {
  if (s.kind !== "let") return null;
  if (s.ty.kind !== "optional") return null;
  const init = s.init;
  if (init.kind !== "index") return null;
  if (init.obj.ty.kind !== "array") return null;
  if (init.ty.kind === "optional") return null;  // array-of-optionals: not a flag artifact
  const cond = arrayBoundsCond(init.obj, init.idx);
  const undef: TExpr = { kind: "var", name: "undefined", ty: { kind: "void" } };
  const guarded: TExpr = { kind: "conditional", cond, then: init, else: undef, ty: s.ty };
  return { ...s, init: guarded };
}

/** Driver (expression): `obj?.<chain>` — single-eval optional chain.
 *  → `someMatch obj { Some(_oc{N}_val) => apply(chain, _oc{N}_val), None => undefined }`.
 *  The someBody applies the chain to the binder directly (field/call/index),
 *  so transform doesn't substitute. Scrutinee can be any expression. */
function ruleOptChain(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "optChain") return null;
  if (e.obj.ty.kind !== "optional") return null;
  const innerTy = e.obj.ty.inner;
  const binder = freshOcBinder(ctx);
  const body = applyChain({ kind: "var", name: binder, ty: innerTy }, e.chain);
  const noneBody: TExpr = { kind: "var", name: "undefined", ty: { kind: "void" } };
  return {
    kind: "someMatch",
    scrutinee: e.obj, binder, binderTy: innerTy,
    someBody: body, noneBody, ty: e.ty,
  };
}

/** Driver (expression): `k in m ? m[k] : default` — key-membership fact in
 *  ternary position, m map-typed. The then-branch must be exactly `m[k]`.
 *  → `someMatch m[k] { Some(_m_k_val) => _m_k_val, None => default }`.
 *  The existing Dafny peephole collapses the result to
 *  `if k in m then m[k] else default`. */
function ruleConditionalInMap(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  if (e.cond.kind !== "binop" || e.cond.op !== "in") return null;
  const m = e.cond.right;
  const k = e.cond.left;
  if (m.ty.kind !== "map") return null;
  // Then-branch must be exactly m[k].
  if (e.then.kind !== "index") return null;
  if (!exprEqual(e.then.obj, m) || !exprEqual(e.then.idx, k)) return null;
  // Only narrow when the else branch has a concrete non-optional type — otherwise
  // the overall ternary could legitimately be Option<V> (e.g., `k in m ? m[k] : undefined`).
  if (e.else.ty.kind === "optional" || e.else.ty.kind === "void") return null;
  // Dormant backup: when resolve's in-atom narrowing has already fired, e.then.ty is V,
  // not Option<V>. The `someMatch` scrutinee would then have the wrong shape. Skip —
  // the enclosing expression is already a plain if-then-else of the correct type.
  if (e.then.ty.kind !== "optional") return null;
  const innerTy = m.ty.value;
  const binder = binderHintForMapAccess(m, k, ctx);
  return {
    kind: "someMatch",
    scrutinee: e.then, binder, binderTy: innerTy,
    someBody: { kind: "var", name: binder, ty: innerTy },
    noneBody: e.else, ty: innerTy,
  };
}

/** Driver (expression): `opt ? a : b` (truthiness — cond itself is optional).
 *  Only fires for simple var or simple `obj.field` cond. Historical shape:
 *  no falsy gate on the bound value (unlike the other truthiness positions). */
function ruleConditionalOptionalTruthy(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  if (e.cond.ty.kind !== "optional") return null;
  const binder = freshPathBinder(e.cond, ctx);
  if (binder === null) return null;
  return {
    kind: "someMatch",
    scrutinee: e.cond, binderTy: e.cond.ty.inner,
    binder,
    someBody: e.then, noneBody: e.else, ty: e.ty,
  };
}

/** Driver: `if (x !== undefined && rest) then` (no else) — presence fact in
 *  guarded-if position.
 *  → `someMatch x { Some(_x_val) => if rest then then; , None => {} }`.
 *  Walks the inner if back through narrow so that nested optional checks in
 *  rest also become someMatches. */
function ruleIfAndOptional(s: TStmt, ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  if (s.else.length !== 0) return null;
  const extracted = leadingPresent(s.cond);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  const innerIf: TStmt = { kind: "if", cond: restCond, then: s.then, else: [] };
  return presentMatchStmts(check, [walkStmt(innerIf, ctx)], [], ctx);
}

/** Driver: a bare expression statement `x !== undefined && rest` (the
 *  `if`-less guard idiom, TS-equivalent to `if (x !== undefined) rest;`).
 *  → `someMatch x { Some(_x_val) => rest;, None => {} }`.
 *  Runs `rest` for effect inside the narrowed scope. Unlike the ternary
 *  driver (`ruleConditionalAndOptional`), a method call in `rest` is fine
 *  here: a statement-level someMatch arm keeps it in statement position, so
 *  transform never ANF-lifts it out of the arm. */
function ruleExprStmtAndOptional(s: TStmt, ctx: CondCtx): TStmt | null {
  if (s.kind !== "expr") return null;
  if (s.expr.kind !== "binop" || s.expr.op !== "&&") return null;
  const extracted = leadingPresent(s.expr);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  const innerStmt: TStmt = { kind: "expr", expr: restCond };
  return presentMatchStmts(check, [walkStmt(innerStmt, ctx)], [], ctx);
}

/** Driver (statement): `let x = (e_opt && rest) ? a : b` — presence fact in
 *  conditional-initializer position, where rest may contain method calls.
 *  → `var x: T := b; someMatch e_opt { Some(_v) => { if rest { x := a } } }`.
 *  Statement-level form is needed because Dafny doesn't allow method calls
 *  inside match expression arms. */
function ruleLetCondAndOptional(s: TStmt, ctx: CondCtx): TStmt[] | null {
  if (s.kind !== "let" || s.mutable) return null;
  if (s.init.kind !== "conditional") return null;
  const extracted = leadingPresent(s.init.cond);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  const assignIf: TStmt = { kind: "if", cond: restCond,
    then: [{ kind: "assign", target: s.name, value: s.init.then }], else: [] };
  return [
    { kind: "let", name: s.name, ty: s.ty, mutable: true, init: s.init.else },
    presentMatchStmts(check, [assignIf], [], ctx),
  ];
}

/** Does this expression contain a method call that would be lifted to a
 *  var binding outside its containing expression by transform? Such calls
 *  are unsafe inside a match arm — the lifted binding would reference a
 *  name only valid in the arm. Builtins whose registry entry is `pure`
 *  (they lower to pure Dafny expressions: `x in arr`, `x in m`, `s.Keys`,
 *  …) are exempt even though they carry `callKind: "method"`. */
function containsMethodCall(e: TExpr): boolean {
  if (e.kind === "call" && e.callKind === "method" &&
      !(e.builtinId !== undefined && builtinSpec(e.builtinId).pure)) {
    return true;
  }
  switch (e.kind) {
    case "var": case "num": case "bigint": case "str": case "bool":
    case "havoc":
      return false;
    case "binop": return containsMethodCall(e.left) || containsMethodCall(e.right);
    case "unop": return containsMethodCall(e.expr);
    case "call": return containsMethodCall(e.fn) || e.args.some(containsMethodCall);
    case "index": return containsMethodCall(e.obj) || containsMethodCall(e.idx);
    case "field": return containsMethodCall(e.obj);
    case "record":
      return (e.spread ? containsMethodCall(e.spread) : false) ||
        e.fields.some(f => containsMethodCall(f.value));
    case "arrayLiteral": return e.elems.some(containsMethodCall);
    case "lambda": return false;  // body is its own scope
    case "conditional":
      return containsMethodCall(e.cond) || containsMethodCall(e.then) || containsMethodCall(e.else);
    case "optChain": return containsMethodCall(e.obj);
    case "nullish": return containsMethodCall(e.left) || containsMethodCall(e.right);
    case "forall": case "exists": return containsMethodCall(e.body);
    case "someMatch": return containsMethodCall(e.scrutinee) ||
      containsMethodCall(e.someBody) || containsMethodCall(e.noneBody);
    case "tagMatch": return containsMethodCall(e.scrutinee) ||
      e.cases.some(c => containsMethodCall(c.body)) ||
      (e.fallthrough ? containsMethodCall(e.fallthrough) : false);
  }
}

/** Driver (expression): `x !== undefined && rest ? a : b` — presence fact in
 *  guarded-ternary position.
 *  → `someMatch x { Some(_x_val) => if rest then a else b, None => b }`.
 *  Walks the inner conditional back through narrow so chained checks become
 *  nested someMatches. Does NOT fire if the guard `rest` contains method
 *  calls — transform lifts those out of the match arm, breaking the binder
 *  scope. The original transform's let-desugar handles those by lifting to
 *  a mutable var first. */
function ruleConditionalAndOptional(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  const extracted = leadingPresent(e.cond);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  if (containsMethodCall(restCond)) return null;
  const innerCond: TExpr = {
    kind: "conditional",
    cond: restCond, then: e.then, else: e.else, ty: e.ty,
  };
  return presentMatchExpr(check, walkExpr(innerCond, ctx), e.else, e.ty, ctx);
}

// ── Variant drivers (discriminants and synth array-unions) ──

/** Driver (expression): `Array.isArray(x) ==> B` or `!Array.isArray(x) ==> B` —
 *  isArray fact in implication position (spec premises).
 *  → `tagMatch x { ArrayBranch => walkExpr(B), _ => true }` (or NonArrayBranch).
 *  The other variant becomes a vacuous-true fallthrough. */
function ruleImplArrayIsArray(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "binop" || e.op !== "==>") return null;
  const pos = isArrayFact(e.left, ctx);
  const neg = e.left.kind === "unop" && e.left.op === "!"
    ? isArrayFact(e.left.expr, ctx)
    : null;
  const matched = pos ?? (neg ? { scrutinee: neg.scrutinee, typeName: neg.typeName, variant: "NonArrayBranch" as const } : null);
  if (!matched) return null;
  return {
    kind: "tagMatch",
    scrutinee: matched.scrutinee,
    typeName: matched.typeName,
    cases: [{ variant: matched.variant, body: walkExpr(e.right, ctx) }],
    fallthrough: { kind: "bool", value: true, ty: { kind: "bool" } },
    ty: { kind: "bool" },
  };
}

/** Driver (expression): `Array.isArray(x) ? a : b` — isArray fact in ternary
 *  position (also `typeof x === "string"`, which selects the NonArrayBranch).
 *  → `tagMatch x { <variant> => walkExpr(then-side) } fallthrough walkExpr(else-side)`.
 *  Inside the matched arm, bare references to `x` are rewritten to the
 *  variant's payload field by `transformExpr` when emitting the tagMatch. */
function ruleConditionalArrayIsArray(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  const pos = isArrayFact(e.cond, ctx);
  // `typeof x === "string"` is a positive check like `Array.isArray`, but selects
  // the NonArrayBranch — its then-branch is the matched-variant body.
  const tof = pos ? null : typeofStringFact(e.cond, ctx);
  const neg = !pos && !tof && e.cond.kind === "unop" && e.cond.op === "!"
    ? isArrayFact(e.cond.expr, ctx)
    : null;
  const matched = pos ?? tof ?? (neg ? { scrutinee: neg.scrutinee, typeName: neg.typeName, variant: "NonArrayBranch" as const } : null);
  if (!matched) return null;
  // The selected variant already accounts for negation. Its arm always runs
  // the source then-branch; swapping branches here would negate the test twice.
  return {
    kind: "tagMatch",
    scrutinee: matched.scrutinee,
    typeName: matched.typeName,
    cases: [{ variant: matched.variant, body: walkExpr(e.then, ctx) }],
    fallthrough: walkExpr(e.else, ctx),
    ty: e.ty,
  };
}

/** Driver: `if (<rest> && Array.isArray(path) && <more>) then [else]` —
 *  isArray fact in guarded-if position.
 *  → `tagMatch path { ArrayBranch => if (<rest && more>) then [else] }`.
 *  The remaining conjuncts move inside the matched arm so any narrowing the
 *  `then` body relies on (typed `path` accesses) sees the unwrapped variant. */
function ruleIfAndArrayIsArray(s: TStmt, ctx: CondCtx): TStmt | null {
  if (s.kind !== "if") return null;
  const extracted = leadingIsArray(s.cond, ctx);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  // Inner if uses the remaining conjunction. Walk recursively so nested
  // checks compose.
  const innerThen: TStmt[] = [{ kind: "if", cond: restCond, then: s.then, else: s.else }];
  return {
    kind: "tagMatch",
    scrutinee: check.scrutinee,
    typeName: check.typeName,
    cases: [{ variant: check.variant, body: innerThen.map(x => walkStmt(x, ctx)) }],
    fallthrough: s.else,
  };
}

/** Driver (expression): `(<rest> && Array.isArray(path)) ? a : b` — isArray
 *  fact in guarded-ternary position.
 *  → `tagMatch path { ArrayBranch => (<rest>) ? a : b } fallthrough b`. */
function ruleConditionalAndArrayIsArray(e: TExpr, ctx: CondCtx): TExpr | null {
  if (e.kind !== "conditional") return null;
  const extracted = leadingIsArray(e.cond, ctx);
  if (!extracted) return null;
  const { check, restCond } = extracted;
  const innerCond: TExpr = {
    kind: "conditional",
    cond: restCond, then: e.then, else: e.else, ty: e.ty,
  };
  return {
    kind: "tagMatch",
    scrutinee: check.scrutinee,
    typeName: check.typeName,
    cases: [{ variant: check.variant, body: walkExpr(innerCond, ctx) }],
    fallthrough: e.else,
    ty: e.ty,
  };
}

/** Driver (list-level): consecutive `if (x.kind === "v") ...` chain →
 *  tagMatch. Walks consecutive top-level ifs on the same discriminator var;
 *  the first one with an else-branch ends the chain (else becomes
 *  fallthrough; if-else-if flattens into more cases). Returns the tagMatch
 *  and how many stmts consumed. */
function ruleDiscriminantChain(stmts: TStmt[], ctx: CondCtx): { stmt: TStmt; consumed: number } | null {
  if (stmts.length === 0 || stmts[0].kind !== "if") return null;
  const first = variantFact(stmts[0].cond, ctx);
  if (!first) return null;

  const cases: { variant: string; body: TStmt[] }[] = [];

  function collectElse(s: TStmt & { kind: "if" }): TStmt[] {
    const p = variantFact(s.cond, ctx);
    if (!p || p.scrutinee.name !== first!.scrutinee.name) return [s];
    cases.push({ variant: p.variant, body: s.then });
    if (s.else.length === 0) return [];
    if (s.else.length === 1 && s.else[0].kind === "if") return collectElse(s.else[0]);
    return s.else;
  }

  let consumed = 0;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.kind !== "if") break;
    const p = variantFact(s.cond, ctx);
    if (!p || p.scrutinee.name !== first.scrutinee.name) break;
    cases.push({ variant: p.variant, body: s.then });
    consumed = i + 1;
    if (s.else.length > 0) {
      const ft = (s.else.length === 1 && s.else[0].kind === "if") ? collectElse(s.else[0]) : s.else;
      return { stmt: { kind: "tagMatch", scrutinee: first.scrutinee, typeName: first.typeName,
        cases, fallthrough: ft }, consumed };
    }
  }
  if (cases.length === 0) return null;
  // If every case terminates, the trailing statements are the default arm
  // (preserving the clean dispatch-as-expression shape). Otherwise the tail runs
  // after the match for every variant, so leave it to the caller (empty default)
  // rather than mis-routing it into the default arm only.
  if (cases.every(c => isTerminating(c.body))) {
    return { stmt: { kind: "tagMatch", scrutinee: first.scrutinee, typeName: first.typeName,
      cases, fallthrough: stmts.slice(consumed) }, consumed: stmts.length };
  }
  return { stmt: { kind: "tagMatch", scrutinee: first.scrutinee, typeName: first.typeName,
    cases, fallthrough: [] }, consumed };
}

/** Driver (list-level): `if (x.kind !== "v") terminate; rest` → tagMatch
 *  with cases = [{ variant: v, body: rest }] and fallthrough = terminate. */
function ruleDiscriminantNegEarlyReturn(stmts: TStmt[], ctx: CondCtx): { stmt: TStmt; consumed: number } | null {
  if (stmts.length < 2) return null;
  const first = stmts[0];
  if (first.kind !== "if" || first.else.length > 0) return null;
  if (!isTerminating(first.then)) return null;
  const cond = negVariantFact(first.cond, ctx);
  if (!cond) return null;
  return { stmt: { kind: "tagMatch", scrutinee: cond.scrutinee, typeName: cond.typeName,
    cases: [{ variant: cond.variant, body: stmts.slice(1) }], fallthrough: first.then },
    consumed: stmts.length };
}

// ── Function / module entry ──────────────────────────────────

function narrowFunction(fn: TFunction, ctx: CondCtx): TFunction {
  // Contracts and the body bind their payloads in separate generated scopes.
  // Do not reserve a body's names because of a contract's \result (or another
  // function's paths). Keep the shared counter's traversal order unchanged.
  const specCtx: CondCtx = { decls: ctx.decls, oc: ctx.oc };
  const bodyCtx: CondCtx = { decls: ctx.decls, oc: ctx.oc };
  return {
    ...fn,
    requires: fn.requires.map(e => walkExpr(e, specCtx)),
    ensures: fn.ensures.map(e => walkExpr(e, specCtx)),
    decreases: fn.decreases ? walkExpr(fn.decreases, specCtx) : null,
    body: walkStmts(fn.body, bodyCtx),
  };
}

export function narrowModule(mod: TModule): TModule {
  const ctx: CondCtx = { decls: mod.typeDecls, oc: { n: 0 } };
  return {
    ...mod,
    constants: mod.constants.map(c => ({ ...c, value: walkExpr(c.value, ctx) })),
    functions: mod.functions.map(fn => narrowFunction(fn, ctx)),
    classes: mod.classes.map(cls => ({
      ...cls,
      methods: cls.methods.map(m => narrowFunction(m, ctx)),
    })),
  };
}
