import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleLean } from "../src/transform.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";
import type { Expr, Stmt, FnMethod } from "../src/ir.ts";

// Velvet rejects `return` inside a loop, so the Lean backend rewrites an in-loop
// return to an assignment and a break. A normal loop exit must still run the
// source's continuation against the final loop state.
const CASES = [
  { name: "normalExit", run: normalExit, body: `
    let i = 0;
    while (i < 2) {
      //@ invariant i >= 0 && i <= 2
      //@ decreases 2 - i
      //@ done_with true
      if (i < 0) return -1;
      i = i + 1;
    }
    return i;` },
  { name: "earlyExit", run: earlyExit, body: `
    let i = 0;
    while (i < 5) {
      //@ invariant i >= 0 && i <= 5
      //@ decreases 5 - i
      //@ done_with true
      if (i === 3) return 10 * i;
      i = i + 1;
    }
    return i;` },
  { name: "continuation", run: continuation, body: `
    let i = 0;
    while (i < 2) {
      //@ invariant i >= 0 && i <= 2
      //@ decreases 2 - i
      //@ done_with true
      if (i < 0) return -1;
      i = i + 1;
    }
    i = i + 7;
    return i;` },
  { name: "userNames", run: userNames, body: `
    let _loopRet = 1;
    let _loopDone = 4;
    let i = 0;
    while (i < 2) {
      //@ invariant i >= 0 && i <= 2
      //@ decreases 2 - i
      //@ done_with true
      if (i < 0) return -1;
      i = i + 1;
    }
    return _loopRet + _loopDone + i;` },
] as const;

function source(): string {
  return CASES.map(c => `export function ${c.name}(): number {${c.body}\n}`).join("\n\n");
}

/** The TypeScript the regression functions run as, so the expected values come from the source. */
function normalExit(): number {
  let i = 0;
  while (i < 2) {
    if (i < 0) return -1;
    i = i + 1;
  }
  return i;
}
function earlyExit(): number {
  let i = 0;
  while (i < 5) {
    if (i === 3) return 10 * i;
    i = i + 1;
  }
  return i;
}
function continuation(): number {
  let i = 0;
  while (i < 2) {
    if (i < 0) return -1;
    i = i + 1;
  }
  i = i + 7;
  return i;
}
function userNames(): number {
  const _loopRet = 1;
  const _loopDone = 4;
  let i = 0;
  while (i < 2) {
    if (i < 0) return -1;
    i = i + 1;
  }
  return _loopRet + _loopDone + i;
}

function lower(fileName: string, text: string): { methods: FnMethod[]; lean: string } {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const file = project.createSourceFile(fileName, text);
  assert.deepEqual(project.getPreEmitDiagnostics().map(d => d.getMessageText()), [], "the regression must be valid TypeScript");
  const { defFile } = transformModuleLean(narrowModule(resolveModule(extractModule(file))));
  resetLeanModule();
  const methods = defFile.decls.filter((d): d is FnMethod => d.kind === "method");
  return { methods, lean: emitLeanFile(defFile) };
}

// A big-step evaluator for the integer fragment the rewrite produces: what the
// emitted Lean method computes, read off the rewritten statements.
type Value = number | boolean;
class Return { constructor(readonly value: Value) {} }
class Break {}

function evalExpr(e: Expr, env: Map<string, Value>): Value {
  switch (e.kind) {
    case "num": return e.value;
    case "bool": return e.value;
    case "default": return 0;
    case "var": {
      assert.ok(env.has(e.name), `unbound ${e.name}`);
      return env.get(e.name)!;
    }
    case "unop": {
      const v = evalExpr(e.expr, env);
      if (e.op === "-") return -(v as number);
      if (e.op === "¬" || e.op === "!") return !v;
      break;
    }
    case "binop": {
      const l = evalExpr(e.left, env) as number, r = evalExpr(e.right, env) as number;
      switch (e.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "<": return l < r;
        case "≤": case "<=": return l <= r;
        case ">": return l > r;
        case "≥": case ">=": return l >= r;
        case "=": case "==": case "===": return l === r;
      }
      break;
    }
  }
  assert.fail(`evaluator does not cover ${JSON.stringify(e)}`);
}

function exec(stmts: readonly Stmt[], env: Map<string, Value>): void {
  for (const s of stmts) {
    switch (s.kind) {
      case "let": env.set(s.name, evalExpr(s.value, env)); break;
      case "assign": env.set(s.target, evalExpr(s.value, env)); break;
      case "return": throw new Return(evalExpr(s.value, env));
      case "break": throw new Break();
      case "if": exec(evalExpr(s.cond, env) ? s.then : s.else, env); break;
      case "while":
        try {
          while (evalExpr(s.cond, env)) exec(s.body, env);
        } catch (x) {
          if (!(x instanceof Break)) throw x;
        }
        break;
      default: assert.fail(`evaluator does not cover ${s.kind}`);
    }
  }
}

function run(m: FnMethod): Value {
  try {
    exec(m.body, new Map());
  } catch (x) {
    if (x instanceof Return) return x.value;
    throw x;
  }
  assert.fail(`${m.name} fell off its end`);
}

const { methods, lean } = lower("loop-return.ts", source());

for (const c of CASES) {
  test(`Lean ${c.name} returns what the TypeScript returns`, () => {
    const m = methods.find(m => m.name === c.name);
    assert.ok(m, `no method ${c.name}`);
    assert.ok(!JSON.stringify(m.body.filter(s => s.kind === "while").map(s => s.body)).includes("\"return\""),
      "Velvet forbids return inside a loop");
    assert.equal(run(m), c.run());
  });
}

test("minted loop names prime past user-written ones", () => {
  assert.match(lean, /let mut _loopRet' : Int := 0/);
  assert.match(lean, /let mut _loopDone' : Bool := false/);
});

test("a loop that ends the method returns its result variable on every exit", () => {
  const { methods } = lower("loop-tail.ts", `export function find(): number {
  let i = 0;
  while (true) {
    //@ invariant i >= 0
    //@ done_with true
    if (i === 3) return i;
    i = i + 1;
  }
}`);
  assert.equal(run(methods[0]), 3);
});

test("the postcondition invariant holds only after an in-loop return", () => {
  const { lean } = lower("loop-ensures.ts", `//@ ensures \\result >= 0
export function bounded(): number {
  let i = 0;
  while (i < 2) {
    //@ invariant i >= 0 && i <= 2
    //@ decreases 2 - i
    //@ done_with true
    if (i < 0) return 0;
    i = i + 1;
  }
  return i;
}`);
  assert.match(lean, /invariant invariant_\d+: \(_loopDone → _loopRet ≥ 0 : Prop\)/);
  assert.match(lean, /if _loopDone then\n\s+return _loopRet\n\s+return i/);
});
