/**
 * auto-havoc pass — validation mode.
 *
 * Rewrites every *unmodellable* expression in the Typed IR to a `havoc` node,
 * and drops unmodellable side-effecting statements. "Unmodellable" = the value
 * derives from something outside LemmaScript's model (an `unknown`-typed
 * receiver/result — e.g. `res.status()`, `req.body`, `JSON.parse(x)`,
 * `process.env.X ?? y`, `uuidv4()` — or an anonymous object literal).
 *
 * This is the abstraction policy for verifying *validation* properties: the
 * only thing that matters is that values reaching a contracted sink (an extern
 * with `//@ requires sanitizer(x)`) are dominated by the sanitizer guard.
 * Everything else is noise and is replaced by an arbitrary value.
 *
 * Soundness: `havoc` is a nondeterministic over-approximation — the verifier
 * assumes nothing about a havoc'd value — so this can only make a proof FAIL
 * (false positive), never spuriously pass. It uses havoc, never assume.
 * (Trust boundary: a real sink hidden inside an unmodellable call is invisible;
 * sinks must be the declared/annotated externs.)
 *
 * It runs after narrow, so any legitimate optional (`?.`, `??` on an
 * optional-typed value) is already a `someMatch`; a `nullish`/`optChain` that
 * survives to here is unmodellable and gets havoc'd.
 */

import type { TExpr, TStmt, TModule } from "./typedir.js";

/** A node whose own value can't be modeled and must become an arbitrary value.
 *  Leaves (var/literal/havoc) are never havoc'd — a reference to an already
 *  havoc'd variable is fine; only the *source* expression is replaced. */
function isBadNode(e: TExpr): boolean {
  switch (e.kind) {
    case "var": case "num": case "bigint": case "str": case "bool": case "havoc":
      return false;
    // A field/index is unmodellable when its *object* is opaque (`req.body`,
    // `process.env.X`). It is NOT unmodellable just because its own type is
    // `unknown`: a method reference on a known receiver (`path.includes`) has
    // `unknown` type yet emits fine — the method dispatch happens at emit on
    // the object's type, so havocing it would wreck a legitimate call.
    case "field": return e.obj.ty.kind === "unknown";
    case "index": return e.obj.ty.kind === "unknown";
    // anonymous object literal — Dafny has no model for it
    case "record": return e.ty.kind !== "user";
    // a call / nullish / opt-chain / conditional whose *result* is opaque
    default: return e.ty.kind === "unknown";
  }
}

/** Does the subtree (including lambda bodies) contain anything unmodellable?
 *  Used to havoc a *whole* call like `xs.map(v => ({...}))` whose receiver is
 *  modellable but whose lambda produces an unmodellable value — havocing the
 *  lambda interior would leave a nondeterministic `*` inside a pure lambda. */
function containsBad(e: TExpr): boolean {
  let found = false;
  const visit = (n: TExpr): void => {
    if (found) return;
    if (isBadNode(n)) { found = true; return; }
    forEachChildExpr(n, visit);
  };
  visit(e);
  return found;
}

function mustHavoc(e: TExpr): boolean {
  if (isBadNode(e)) return true;
  if (e.kind === "call" && e.args.some(a => a.kind === "lambda" && a.body.some(s => stmtContainsBad(s))))
    return true;
  return false;
}

// ── structural recursion helpers ────────────────────────────

function forEachChildExpr(e: TExpr, f: (c: TExpr) => void): void {
  switch (e.kind) {
    case "binop": f(e.left); f(e.right); return;
    case "unop": f(e.expr); return;
    case "call": f(e.fn); e.args.forEach(f); return;
    case "index": f(e.obj); f(e.idx); return;
    case "field": f(e.obj); return;
    case "record": if (e.spread) f(e.spread); e.fields.forEach(fl => f(fl.value)); return;
    case "arrayLiteral": e.elems.forEach(f); return;
    case "conditional": f(e.cond); f(e.then); f(e.else); return;
    case "optChain": f(e.obj); return;
    case "nullish": f(e.left); f(e.right); return;
    case "forall": case "exists": f(e.body); return;
    case "someMatch": f(e.scrutinee); f(e.someBody); f(e.noneBody); return;
    case "tagMatch": f(e.scrutinee); e.cases.forEach(c => f(c.body)); if (e.fallthrough) f(e.fallthrough); return;
    case "lambda": e.body.forEach(s => forEachChildExprInStmt(s, f)); return;
  }
}

function forEachChildExprInStmt(s: TStmt, f: (c: TExpr) => void): void {
  switch (s.kind) {
    case "let": case "ghostLet": f(s.init); return;
    case "assign": case "ghostAssign": f(s.value); return;
    case "return": f(s.value); return;
    case "expr": f(s.expr); return;
    case "assert": f(s.expr); return;
    case "if": f(s.cond); s.then.forEach(st => forEachChildExprInStmt(st, f)); s.else.forEach(st => forEachChildExprInStmt(st, f)); return;
    case "while": f(s.cond); s.body.forEach(st => forEachChildExprInStmt(st, f)); return;
    case "forof": f(s.iterable); s.body.forEach(st => forEachChildExprInStmt(st, f)); return;
    case "switch": f(s.expr); s.cases.forEach(c => c.body.forEach(st => forEachChildExprInStmt(st, f))); s.defaultBody.forEach(st => forEachChildExprInStmt(st, f)); return;
    case "someMatch": f(s.scrutinee); s.someBody.forEach(st => forEachChildExprInStmt(st, f)); s.noneBody.forEach(st => forEachChildExprInStmt(st, f)); return;
    case "tagMatch": f(s.scrutinee); s.cases.forEach(c => c.body.forEach(st => forEachChildExprInStmt(st, f))); s.fallthrough.forEach(st => forEachChildExprInStmt(st, f)); return;
  }
}

function stmtContainsBad(s: TStmt): boolean {
  let found = false;
  forEachChildExprInStmt(s, e => { if (containsBad(e)) found = true; });
  return found;
}

// ── contracted-call ("sink") detection ──────────────────────
// A call whose callee carries a `//@ requires` precondition. When we havoc an
// unmodellable expression we must NOT silently discard such a call nested
// inside it — its precondition would go unchecked (a false pass). Instead we
// hoist it to a discard statement so the precondition is still verified.

let _guarded = new Set<string>();
// Every name LemmaScript models: local functions + all externs. A call to
// anything else with an unknown callee is "opaque" — abstracted by havoc.
let _known = new Set<string>();

function calleeName(e: TExpr): string | null {
  if (e.kind !== "call") return null;
  if (e.fn.kind === "var") return e.fn.name;
  if (e.fn.kind === "field") return e.fn.field;
  return null;
}

/** Root variable a receiver chain bottoms out at (`fs.x.y` → `fs`,
 *  `res.status(400).send` → `res`, `templateJson.variables.map` → `templateJson`). */
function rootVar(e: TExpr): string | null {
  let cur = e;
  for (;;) {
    if (cur.kind === "var") return cur.name;
    if (cur.kind === "field") cur = cur.obj;
    else if (cur.kind === "call") cur = cur.fn;
    else if (cur.kind === "index") cur = cur.obj;
    else return null;
  }
}

/** Display name of an *opaque external* call this pass abstracts away — a call
 *  on an unknown receiver rooted at a module/global (`fs.readFileSync`,
 *  `JSON.parse`) or an unknown free function (`uuidv4`). Returns null for
 *  modelled calls (local functions, contracted/dispatched externs, methods on
 *  known receivers) and for calls rooted at a function-local/param (e.g.
 *  `templateJson.variables.map`, `res.status().send` — framework objects and
 *  havoc'd locals, not external sinks). These are the calls a completeness
 *  reviewer must confirm are not unguarded sinks. */
function opaqueCallName(e: TExpr, locals: Set<string>): string | null {
  // Report exactly the calls the pass abstracts. A call is havoc'd iff its
  // result type is unknown (the same `isBadNode`/`mustHavoc` criterion the pass
  // uses) — keying on that, rather than re-matching the callee's syntax, makes
  // the report complete: it can't miss an unusual form like `fs["read"](p)`.
  if (e.kind !== "call" || e.ty.kind !== "unknown") return null;
  const root = rootVar(e.fn);
  // Not an external sink: rooted at a parameter/local value (framework objects,
  // havoc'd locals) or at a known function/extern (already modelled).
  if (root && (locals.has(root) || _known.has(root))) return null;
  // Best display we can give the callee.
  const f = e.fn;
  if (f.kind === "field" && f.obj.kind === "var") return `${f.obj.name}.${f.field}`;
  if (f.kind === "field") return f.field;
  if (f.kind === "index" && f.obj.kind === "var" && f.idx.kind === "str") return `${f.obj.name}.${f.idx.value}`;
  if (f.kind === "var") return f.name;
  return root ?? "<computed call>";
}

/** Every binder in scope anywhere in a function body — params (seed) + let /
 *  forof / lambda parameters — so a call rooted at any of them is treated as a
 *  local value, not an external sink. A call rooted at a *free* name (a module
 *  or global like `fs`/`JSON`/`console`, or a free function like `uuidv4`) is
 *  what the report keeps. Still descends into lambdas so a sink hidden in a
 *  callback (`arr.forEach(x => fs.writeFileSync(x))`) is not missed. */
function localNames(stmts: TStmt[], seed: Set<string>): Set<string> {
  const out = new Set(seed);
  const inExpr = (e: TExpr): void => {
    if (e.kind === "lambda") { e.params.forEach(p => out.add(p.name)); inStmts(e.body); return; }
    forEachChildExpr(e, inExpr);
  };
  const inStmts = (ss: TStmt[]): void => {
    for (const s of ss) {
      if (s.kind === "let" || s.kind === "ghostLet") out.add(s.name);
      if (s.kind === "forof") s.names.forEach(n => out.add(n));
      forEachChildExprInStmt(s, inExpr);
      if (s.kind === "if") { inStmts(s.then); inStmts(s.else); }
      else if (s.kind === "while" || s.kind === "forof") inStmts(s.body);
      else if (s.kind === "switch") { s.cases.forEach(c => inStmts(c.body)); inStmts(s.defaultBody); }
      else if (s.kind === "someMatch") { inStmts(s.someBody); inStmts(s.noneBody); }
      else if (s.kind === "tagMatch") { s.cases.forEach(c => inStmts(c.body)); inStmts(s.fallthrough); }
    }
  };
  inStmts(stmts);
  return out;
}

/** All opaque external calls in a function body (deduped, sorted). */
function collectOpaqueCalls(stmts: TStmt[], locals: Set<string>): string[] {
  const found = new Set<string>();
  const visit = (e: TExpr): void => {
    const n = opaqueCallName(e, locals);
    if (n) found.add(n);
    forEachChildExpr(e, visit);
  };
  for (const s of stmts) forEachChildExprInStmt(s, visit);
  return [...found].sort();
}

/** Outermost contracted calls inside `e`'s subtree (excluding `e` itself, which
 *  is the havoc'd wrapper). Does not descend into lambdas — a sink there would
 *  reference the lambda's binder and can't be hoisted to the enclosing scope. */
function collectSinks(e: TExpr): TExpr[] {
  const out: TExpr[] = [];
  const walk = (n: TExpr): void => {
    if (n.kind === "lambda") return;
    const name = calleeName(n);
    if (name && _guarded.has(name)) { out.push(n); return; }  // outermost: don't descend
    forEachChildExpr(n, walk);
  };
  forEachChildExpr(e, walk);
  return out;
}

// ── rewrite ──────────────────────────────────────────────────
// `hoisted` accumulates discard statements (preserved contracted calls) to be
// emitted, in order, immediately before the statement being rewritten.

function rewriteExpr(e: TExpr, hoisted: TStmt[]): TExpr {
  if (mustHavoc(e)) {
    // Preserve any contracted call nested inside the discarded value so its
    // precondition is still checked. transform lowers the `expr` discard to
    // `var _ := call(...)` (and lifts any havoc'd args), so we lean on it.
    for (const sink of collectSinks(e)) {
      hoisted.push({ kind: "expr", expr: rewriteExpr(sink, hoisted) });
    }
    return { kind: "havoc", ty: e.ty };
  }
  switch (e.kind) {
    case "var": case "num": case "bigint": case "str": case "bool": case "havoc": return e;
    case "binop": return { ...e, left: rewriteExpr(e.left, hoisted), right: rewriteExpr(e.right, hoisted) };
    case "unop": return { ...e, expr: rewriteExpr(e.expr, hoisted) };
    case "call": return { ...e, fn: rewriteExpr(e.fn, hoisted), args: e.args.map(a => rewriteExpr(a, hoisted)) };
    case "index": return { ...e, obj: rewriteExpr(e.obj, hoisted), idx: rewriteExpr(e.idx, hoisted) };
    case "field": return { ...e, obj: rewriteExpr(e.obj, hoisted) };
    case "record": return { ...e, spread: e.spread ? rewriteExpr(e.spread, hoisted) : null,
      fields: e.fields.map(fl => ({ ...fl, value: rewriteExpr(fl.value, hoisted) })) };
    case "arrayLiteral": return { ...e, elems: e.elems.map(el => rewriteExpr(el, hoisted)) };
    case "conditional": return { ...e, cond: rewriteExpr(e.cond, hoisted), then: rewriteExpr(e.then, hoisted), else: rewriteExpr(e.else, hoisted) };
    case "optChain": return { ...e, obj: rewriteExpr(e.obj, hoisted) };
    case "nullish": return { ...e, left: rewriteExpr(e.left, hoisted), right: rewriteExpr(e.right, hoisted) };
    case "forall": case "exists": return { ...e, body: rewriteExpr(e.body, hoisted) };
    case "someMatch": return { ...e, scrutinee: rewriteExpr(e.scrutinee, hoisted), someBody: rewriteExpr(e.someBody, hoisted), noneBody: rewriteExpr(e.noneBody, hoisted) };
    case "tagMatch": return { ...e, scrutinee: rewriteExpr(e.scrutinee, hoisted),
      cases: e.cases.map(c => ({ ...c, body: rewriteExpr(c.body, hoisted) })),
      fallthrough: e.fallthrough ? rewriteExpr(e.fallthrough, hoisted) : null };
    // A lambda body is its own statement scope; rewrite it independently
    // (its hoists belong inside the lambda, not the enclosing statement).
    case "lambda": return { ...e, body: rewriteStmts(e.body) };
  }
}

/** A condition in a boolean context. If it touches anything unmodellable
 *  (`!fs.existsSync(...)`), the whole condition becomes a nondeterministic
 *  `bool` — havocing a subexpression would leave a non-bool `*` under `!`/`if`.
 *  A fully modellable guard (`!validPath(x)`, `s === ""`) is left intact, so
 *  the verifier still reasons about it. Contracted calls inside an havoc'd
 *  condition are still hoisted. */
function rewriteCond(e: TExpr, hoisted: TStmt[]): TExpr {
  if (containsBad(e)) {
    for (const sink of collectSinks(e)) {
      hoisted.push({ kind: "expr", expr: rewriteExpr(sink, hoisted) });
    }
    return { kind: "havoc", ty: { kind: "bool" } };
  }
  return rewriteExpr(e, hoisted);
}

function rewriteStmts(stmts: TStmt[]): TStmt[] {
  const out: TStmt[] = [];
  for (const s of stmts) {
    // A side-effecting statement whose value is unmodellable (`xs.forEach(...)`,
    // `console.log(x)`) carries no verification content — drop it, but still
    // preserve any contracted call nested inside it.
    if (s.kind === "expr" && mustHavoc(s.expr)) {
      const h: TStmt[] = [];
      for (const sink of collectSinks(s.expr)) {
        h.push({ kind: "expr", expr: rewriteExpr(sink, h) });
      }
      out.push(...h);
      continue;
    }
    out.push(...rewriteStmt(s));
  }
  return out;
}

function rewriteStmt(s: TStmt): TStmt[] {
  const h: TStmt[] = [];
  const rw = (e: TExpr) => rewriteExpr(e, h);
  switch (s.kind) {
    case "let": { const init = rw(s.init); return [...h, { ...s, init }]; }
    case "ghostLet": { const init = rw(s.init); return [...h, { ...s, init }]; }
    case "assign": { const value = rw(s.value); return [...h, { ...s, value }]; }
    case "ghostAssign": { const value = rw(s.value); return [...h, { ...s, value }]; }
    case "return": { const value = rw(s.value); return [...h, { ...s, value }]; }
    case "expr": { const expr = rw(s.expr); return [...h, { ...s, expr }]; }
    case "assert": { const expr = rw(s.expr); return [...h, { ...s, expr }]; }
    case "if": { const cond = rewriteCond(s.cond, h); return [...h, { ...s, cond, then: rewriteStmts(s.then), else: rewriteStmts(s.else) }]; }
    case "while": { const cond = rewriteCond(s.cond, h); return [...h, { ...s, cond, body: rewriteStmts(s.body) }]; }
    case "forof": { const iterable = rw(s.iterable); return [...h, { ...s, iterable, body: rewriteStmts(s.body) }]; }
    case "switch": { const expr = rw(s.expr); return [...h, { ...s, expr,
      cases: s.cases.map(c => ({ ...c, body: rewriteStmts(c.body) })),
      defaultBody: rewriteStmts(s.defaultBody) }]; }
    case "someMatch": { const scrutinee = rw(s.scrutinee); return [...h, { ...s, scrutinee, someBody: rewriteStmts(s.someBody), noneBody: rewriteStmts(s.noneBody) }]; }
    case "tagMatch": { const scrutinee = rw(s.scrutinee); return [...h, { ...s, scrutinee,
      cases: s.cases.map(c => ({ ...c, body: rewriteStmts(c.body) })),
      fallthrough: rewriteStmts(s.fallthrough) }]; }
    case "break": case "continue": case "throw": return [s];
  }
}

/** Does any statement in the body contain a havoc expression? Havoc is only
 *  valid in Dafny `method`s (its `*` can't appear in a deterministic
 *  `function`), so a body we've havoc'd must be classified impure. */
function bodyHasHavoc(stmts: TStmt[]): boolean {
  let found = false;
  const visit = (e: TExpr): void => {
    if (found) return;
    if (e.kind === "havoc") { found = true; return; }
    forEachChildExpr(e, visit);
  };
  for (const s of stmts) forEachChildExprInStmt(s, visit);
  return found;
}

/** Apply the auto-havoc abstraction to functions opted in via `//@ autohavoc`
 *  (file-level or per-function). A no-op when nothing is annotated. When any
 *  function opts in, also drop module constants whose initializer is
 *  unmodellable (e.g. `const fs = require("fs")` pulled in by reachability). */
export function autoHavocModule(mod: TModule): TModule {
  if (!mod.functions.some(f => f.autohavoc)) return mod;
  // Names of calls carrying a `//@ requires` precondition — these must never be
  // silently discarded by havoc (see collectSinks / rewriteExpr).
  _guarded = new Set<string>();
  for (const e of mod.externs) if (e.requires.length > 0) { _guarded.add(e.qualified); _guarded.add(e.flat); }
  for (const f of mod.functions) if (f.requires.length > 0) _guarded.add(f.name);
  _known = new Set<string>();
  for (const f of mod.functions) _known.add(f.name);
  for (const e of mod.externs) { _known.add(e.qualified); _known.add(e.flat); }
  return {
    ...mod,
    constants: mod.constants.filter(c => !containsBad(c.value)),
    functions: mod.functions.map(f => {
      if (!f.autohavoc) return f;
      // Completeness transparency: surface the opaque external calls this pass
      // abstracts away, so a forgotten sink (e.g. a raw `fs.readFileSync`) is
      // visible rather than silently havoc'd behind a green check.
      const locals = localNames(f.body, new Set(f.params.map(p => p.name)));
      const opaque = collectOpaqueCalls(f.body, locals);
      if (opaque.length > 0) {
        console.error(`autohavoc: ${f.name} abstracts ${opaque.length} external call(s) — confirm none is an unguarded sink: ${opaque.join(", ")}`);
      }
      const body = rewriteStmts(f.body);
      // Havoc forces Dafny `method` emission (`*` is invalid in a `function`).
      const isPure = f.isPure && !bodyHasHavoc(body);
      return { ...f, body, isPure, forcePure: f.forcePure && isPure };
    }),
  };
}
