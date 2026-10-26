import { test } from "node:test"
import assert from "node:assert/strict"
import { Linter } from "eslint"
import tseslint from "typescript-eslint"
import { failureObserved } from "./eslint.frontend-failures.js"

const lint = (source, options = {}) => new Linter().verify(source, [{
  languageOptions: { parser: tseslint.parser },
  plugins: { frontend: { rules: { "failure-observed": failureObserved } } },
  rules: { "frontend/failure-observed": ["error", options] },
}])

const E = 'import { Effect } from "effect";\n'

// Handlers that log, rethrow, or say why they need neither.
const good = [
  // Logs through Effect, in each of its imports.
  E + 'try { x() } catch { Effect.runSync(Effect.logWarning("x")) }',
  'import * as Effect from "effect/Effect"; x.pipe(Effect.catchTag("A", () => Effect.logError("a")))',
  'import { Effect as Fx } from "effect"; x.pipe(Fx.catch(() => Fx.log("a")))',
  E + 'import { Stream } from "effect"; s.pipe(Stream.catchCause(() => Stream.fromEffect(Effect.logError("s"))))',
  // Rethrows: a throw, a failure or defect, a rejection, or a tagged error returned or yielded.
  'try { x() } catch (error) { throw error }',
  'new Promise((resolve, reject) => p.then(resolve).catch(reject))',
  'p.catch((error) => Promise.reject(error))',
  E + 'x.pipe(Effect.catch(() => Effect.fail(1)))',
  E + 'x.pipe(Effect.catchTag("A", Effect.die))',
  E + 'x.pipe(Effect.catchTag("A", () => new Refused()))',
  E + 'x.pipe(Effect.catch(() => { if (y) return; return new Refused() }))',
  E + 'x.pipe(Effect.catch(() => Effect.gen(function* () { yield* new Refused() })))',
  // A same-file helper that logs or rethrows, called, named, or stored.
  E + 'function drop(reason) { return Effect.logWarning("d").pipe(Effect.annotateLogs({ reason })) }\nx.pipe(Effect.catch((e) => drop(e._tag)))',
  E + 'const drop = () => Effect.logWarning("d")\nx.pipe(Effect.catch(drop))',
  E + 'x.pipe(Effect.catch(() => malformed))\nconst malformed = Effect.fail(1)',
  E + 'x.pipe(Effect.catchTags({ A: () => Effect.logWarning("a"), B: Effect.die }))',
  // A helper's name resolves through its scope: a later one of the same name elsewhere doesn't hide it.
  E + 'function f() { const refused = () => Effect.logWarning("r"); return x.pipe(Effect.catch(refused)) }\nfunction g() { const refused = 1; return refused }',
  // A logger the options name.
  ['p.catch((error) => record(error))', { loggers: ["record"] }],
  // Marked: on the line above, on its own line, or inside the handler.
  E + '// expected: a missing row is fine\nx.pipe(Effect.catchTag("A", () => Effect.void))',
  E + 'x.pipe(Effect.catchTag("A", () => Effect.void)) // expected: a missing row is fine',
  'try { JSON.parse(text) } catch {\n  // recorded: the caller logs it as invalid\n  return undefined\n}',
  'promise\n  // expected: the race below handles this\n  .catch(() => {})',
  // A durable plan's or flow's node: the engine records the failed step.
  'import { Node } from "@smthrs/plan"; Node.catch({ onFailure: () => null })',
  'import { Node } from "@smthrs/flow"; Node.catch(x)',
  // onError that logs, and onError as a name being bound or read, not a handler.
  E + 'f({ onError: () => Effect.runSync(Effect.logError("x")) })',
  E + 'f({ "onError": function () { throw new Error("x") } })',
  'const { onError } = options',
  // Not failure handlers at all.
  'x.catchError(() => 1)',
  'catchTag("A", () => 1)',
  'p[key](() => 1)',
  'p.then(() => 1)',
  'f().catchy(() => 1)',
]

// Handlers that swallow.
const bad = [
  'try { x() } catch {}',
  'p.catch(() => undefined)',
  'p.catch()',
  'p["catch"](() => /regex/u.test(s))',
  E + 'x.pipe(Effect.catchTag("A", () => Effect.void))',
  E + 'f().pipe(Effect.catchIf((e) => e.retry, () => Effect.succeed(null)))',
  // The console isn't a record: Effect's Console, or the global one.
  'import { Console, Effect } from "effect"; x.pipe(Effect.catch(() => Console.log("x")))',
  'p.catch(() => console.warn("x"))',
  'p.catch(() => a.b.logWarning("x"))',
  'p.catch(() => Promise.all([]))',
  E + 'x.pipe(Effect.catch(() => { const n = new Map(); return n }))',
  E + 'x.pipe(Effect.catch(() => Effect.gen(function* () { yield* Effect.void })))',
  // A namespace import of the whole package is an Effect module, but not `Effect`'s logs.
  'import * as Fx from "effect"; x.pipe(Fx.catch(() => Fx.log("x")))',
  // A marker too short, or not next to the handler.
  E + '// expected: fine\nx.pipe(Effect.catchTag("A", () => Effect.void))',
  E + '// expected: a missing row is fine\n\nx.pipe(Effect.catchTag("A", () => Effect.void))',
  '// expected: a reason far from it\n\n\np.catch()',
  'f({ onError: () => {} })',
  E + 'x.pipe(Effect.catchTags({ A: () => Effect.logWarning("a"), B: () => Effect.void }))',
  // A handler from elsewhere can't be read: name it in `loggers`, or mark it.
  E + 'import { handler } from "./handler"; x.pipe(Effect.catch(handler))',
  // Helpers are followed only so deep, and a cycle ends.
  E + 'const a = () => b(); const b = () => c(); const c = () => d(); const d = () => e(); const e = () => Effect.logError("x")\np.catch(() => a())',
  'function a() { return b() } function b() { return a() } p.catch(() => a())',
  // The helper a name refers to is the nearest one, whatever another scope declares.
  E + 'const refused = () => Effect.logWarning("r")\nfunction f() { const refused = () => null; return p.catch(refused) }',
  // A member's or a property's name isn't a reference to the helper of that name, nor is a parameter.
  E + 'const drop = () => Effect.logWarning("d")\np.catch(() => ({ drop: x.drop }))',
  E + 'const drop = () => Effect.logWarning("d")\np.catch((drop) => drop)',
  'p.catch(() => x.reject)',
  'export default function () {} let later; const { x } = y; p.catch(() => later)',
]

test("allows a failure handler that logs, rethrows or says why it needs neither", () => {
  for (const source of good) {
    const [code, options] = Array.isArray(source) ? source : [source, {}]
    assert.deepEqual(lint(code, options), [], code)
  }
})

test("flags a failure handler that neither logs nor rethrows, once, naming its form", () => {
  for (const source of bad) {
    const messages = lint(source)
    assert.equal(messages.length, 1, source)
    assert.match(messages[0].message, /frontend\.failure-observed: this .+ neither logs nor rethrows/, source)
  }
  assert.match(lint('try {} catch {}')[0].message, /catch clause/)
  assert.match(lint('p.catch()')[0].message, /\.catch handler/)
  assert.match(lint(E + 'x.pipe(Effect.catchTag("A", () => Effect.void))')[0].message, /Effect\.catchTag handler/)
  assert.match(lint('f({ onError: () => {} })')[0].message, /onError callback/)
})
