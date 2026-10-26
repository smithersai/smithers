// Rule frontend.failure-observed (docs/rules.md): every failure handler in the browser app logs or rethrows. A `catch`
// clause, a promise's `.catch(...)`, an Effect module's `X.catch*(...)` or an `onError` callback that does neither
// swallows a failure no record will ever show (docs/observability.md). A handler that handles no failure says why on
// the line above it, or inside it: `// expected: <a reason of three words or more>`; one whose failure another record
// already shows says which: `// recorded: <the record, in three words or more>`.

// What counts as logging: an Effect log of any level, a call to a function the options name, or a same-file helper that
// does either.
const LOG = /^log(?:Warning|Error|Fatal|Info|Debug|Trace|WithLevel)?$/
// What counts as rethrowing: failing or dying again, through any Effect module (Effect, Stream, Layer, ...).
const FAIL = /^(?:fail|die|interrupt)/
const MARKER = /^\s*(?:expected|recorded):\s*\S+(?:\s+\S+){2,}/
// How deep a handler's same-file helpers are followed.
const DEPTH = 4

const property = (node) => node.computed ? node.property.value : node.property.name
const keyName = (key) => key.type === "Identifier" ? key.name : key.value

export const failureObserved = {
  meta: {
    type: "problem",
    schema: [{
      type: "object",
      properties: { loggers: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    }],
    messages: {
      unobserved: "frontend.failure-observed: this {{form}} neither logs nor rethrows. Log the failure once at Warn or " +
        "Error with a stable code (docs/observability.md), rethrow it, or say on the line above why it handles no " +
        "failure (`// expected: <reason>`) or which record already shows it (`// recorded: <record>`).",
    },
  },
  create(context) {
    const loggers = new Set(context.options[0]?.loggers ?? [])
    const source = context.sourceCode
    // Local names bound to an Effect module, by the module (`Effect`, `Stream`, ...), and to the durable engine's
    // models, @smthrs/flow's and @smthrs/plan's (a plan's `Node.catch` is the engine's, which records the failed step).
    const effect = new Map()
    const flow = new Set()
    const handlers = []

    // The same-file declaration a name refers to, through its scopes: a function's, or a variable's initial value.
    // A parameter, an import or a destructured name has none the rule can read.
    const resolve = (identifier) => {
      for (let scope = source.getScope(identifier); scope !== null; scope = scope.upper) {
        const variable = scope.set.get(identifier.name)
        if (variable === undefined) continue
        // A library's global, such as `Promise`, has no definition here.
        const [def] = variable.defs
        if (def === undefined) return undefined
        if (def.type === "FunctionName") return def.node
        return def.type === "Variable" && def.node.id.type === "Identifier" ? def.node.init ?? undefined : undefined
      }
      return undefined
    }
    // A name being read, not a member's or a property's key.
    const reference = (node) =>
      !(node.parent.type === "MemberExpression" && node.parent.property === node && !node.parent.computed) &&
      !(node.parent.type === "Property" && node.parent.key === node && !node.parent.computed && !node.parent.shorthand)

    const isEffect = (node) => node.type === "Identifier" && effect.has(node.name)
    // Only `Effect`'s logs are the app's records: `Console.log` writes to the console alone.
    const logs = (node) => node.object.type === "Identifier" && effect.get(node.object.name) === "Effect" && LOG.test(property(node))

    // Whether `node`'s code logs or rethrows, following the same-file helpers it names.
    const observes = (node, depth, seen) => {
      let found = false
      const visit = (current) => {
        if (found || current === null || typeof current !== "object") return
        if (Array.isArray(current)) return current.forEach(visit)
        if (typeof current.type !== "string") return
        switch (current.type) {
          case "ThrowStatement":
            found = true
            return
          case "MemberExpression":
            // `Effect.logWarning`, `Effect.fail`, `Effect.die`, called or passed as they are.
            if (logs(current) || (isEffect(current.object) && FAIL.test(property(current)))) {
              found = true
              return
            }
            if (current.object.type === "Identifier" && current.object.name === "Promise" && property(current) === "reject") {
              found = true
              return
            }
            break
          case "Identifier": {
            if (!reference(current)) break
            if (current.name === "reject" || loggers.has(current.name)) {
              found = true
              return
            }
            const target = depth < DEPTH ? resolve(current) : undefined
            if (target !== undefined && !seen.has(target)) {
              seen.add(target)
              if (observes(target, depth + 1, seen)) found = true
              return
            }
            break
          }
          case "ReturnStatement":
          case "YieldExpression":
            // A tagged error returned or yielded fails the Effect with it.
            if (current.argument?.type === "NewExpression") {
              found = true
              return
            }
            break
          case "ArrowFunctionExpression":
            if (current.body.type === "NewExpression") {
              found = true
              return
            }
            break
        }
        for (const [key, value] of Object.entries(current)) {
          if (key !== "parent" && key !== "loc" && key !== "range") visit(value)
        }
      }
      visit(node)
      return found
    }

    // Whether an `expected:` marker ends on the line before `line`, sits on it, or is inside `handler`.
    const marked = (line, handler) =>
      source.getAllComments().some((comment) =>
        MARKER.test(comment.value) &&
        (comment.loc.end.line === line - 1 || comment.loc.start.line === line ||
          (handler !== undefined && comment.range[0] >= handler.range[0] && comment.range[1] <= handler.range[1]))
      )

    const check = (node, line, form, handler) => {
      handlers.push({ node, line, form, handler })
    }

    return {
      ImportDeclaration(node) {
        const module = node.source.value
        for (const specifier of node.specifiers) {
          if (module === "effect") effect.set(specifier.local.name, specifier.imported?.name ?? specifier.local.name)
          if (module.startsWith("effect/")) effect.set(specifier.local.name, module.slice("effect/".length))
          if (module.startsWith("@smthrs/flow") || module === "@smthrs/plan") flow.add(specifier.local.name)
        }
      },
      CatchClause(node) {
        check(node, node.loc.start.line, "catch clause", node.body)
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return
        const name = property(node.callee)
        if (typeof name !== "string" || !name.startsWith("catch")) return
        const object = node.callee.object
        const line = node.callee.property.loc.start.line
        if (isEffect(object)) {
          // The handler is the last argument; `catchTags` takes one per tag.
          const last = node.arguments.at(-1)
          return check(node, line, `${object.name}.${name} handler`, last)
        }
        if (name !== "catch" || (object.type === "Identifier" && flow.has(object.name))) return
        check(node, line, ".catch handler", node.arguments[0])
      },
      Property(node) {
        if (node.parent.type !== "ObjectPattern" && keyName(node.key) === "onError") {
          check(node, node.key.loc.start.line, "onError callback", node.value)
        }
      },
      "Program:exit"() {
        for (const { node, line, form, handler } of handlers) {
          if (marked(line, handler)) continue
          const parts = handler?.type === "ObjectExpression" ? handler.properties.map((entry) => entry.value) : [handler]
          if (parts.every((part) => part !== undefined && observes(part, 0, new Set()))) continue
          context.report({ node, messageId: "unobserved", data: { form } })
        }
      },
    }
  },
}
