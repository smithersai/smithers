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
        if (def.type !== "Variable" || def.node.id.type !== "Identifier") return undefined
        const writes = variable.references.filter(reference => reference.writeExpr)
        // A later replacement must not borrow an earlier helper's observation.
        return writes.length === 1 ? writes[0].writeExpr : undefined
      }
      return undefined
    }
    const isEffect = (node) => node.type === "Identifier" && effect.has(node.name)
    // Only `Effect`'s logs are the app's records: `Console.log` writes to the console alone.
    const logs = (node) => node.object.type === "Identifier" && effect.get(node.object.name) === "Effect" && LOG.test(property(node))

    // A constructed Effect is lazy. Follow only work that a handler executes,
    // returns to an Effect catch, yields in Effect.gen, or runs at a boundary.
    const observes = (node, depth, seen, effectHandler, invoke = true, kind = effectHandler ? "effect" : "native") => {
      const follow = (identifier, kind, invoke) => {
        if (depth >= DEPTH) return false
        const target = resolve(identifier)
        if (target === undefined || seen.has(target)) return false
        return observes(target, depth + 1, new Set(seen).add(target), kind === "effect", invoke, kind)
      }
      const effectCallbacks = /^(?:andThen|flatMap|tap|tapError|tapCause|catch.*|suspend|onError|ensuring|forEach)$/
      const boundaries = /^run(?:Sync|Promise|Fork)(?:Exit|With)?$/
      const walk = (current, kind = "discard", returnKind = kind, invoke = false) => {
        if (current === null || typeof current !== "object") return false
        switch (current.type) {
          case "ArrowFunctionExpression":
          case "FunctionExpression":
          case "FunctionDeclaration":
            if (!invoke) return false
            if (current.body.type === "NewExpression" && kind === "effect") return true
            return walk(current.body, current.body.type === "BlockStatement" ? "discard" : kind, kind)
          case "Identifier":
            if (invoke && (current.name === "reject" || loggers.has(current.name))) return true
            return (invoke || kind === "effect" || kind === "collection") && follow(current, kind, invoke)
          case "ThrowStatement":
            return true
          case "ReturnStatement":
            if (returnKind === "effect" && current.argument?.type === "NewExpression") return true
            return walk(current.argument, returnKind === "generator" ? "native" : returnKind, returnKind)
          case "YieldExpression":
            return returnKind === "generator" && (current.argument?.type === "NewExpression" || walk(current.argument, "effect", returnKind))
          case "AwaitExpression":
            return walk(current.argument, "native", returnKind)
          case "NewExpression":
            return false
          case "SpreadElement":
            return walk(current.argument, kind, returnKind)
          case "ConditionalExpression":
            return walk(current.test, "discard", returnKind) ||
              walk(current.consequent, kind, returnKind, invoke) || walk(current.alternate, kind, returnKind, invoke)
          case "LogicalExpression":
          case "SequenceExpression":
            return current.type === "LogicalExpression"
              ? walk(current.left, current.operator === "&&" ? "discard" : kind, returnKind) || walk(current.right, kind, returnKind)
              : current.expressions.some((expression, index) => walk(expression, index === current.expressions.length - 1 ? kind : "discard", returnKind))
          case "ArrayExpression":
            return current.elements.some(element => walk(element, kind === "collection" ? "effect" : "discard", returnKind))
          case "ObjectExpression":
            return current.properties.some(entry => walk(entry.type === "Property" ? entry.value : entry.argument, kind === "collection" ? "effect" : "discard", returnKind))
          case "MemberExpression":
            return (invoke && kind === "effect" &&
              (logs(current) || (isEffect(current.object) && FAIL.test(property(current))))) ||
              (invoke && current.object.type === "Identifier" && current.object.name === "Promise" && property(current) === "reject")
          case "CallExpression": {
            const callee = current.callee
            if (callee.type === "ConditionalExpression" && walk(callee, kind, returnKind, true)) return true
            if (callee.type === "CallExpression" && callee.callee.type === "MemberExpression" && kind === "effect" && logs(callee.callee)) return true
            if (callee.type === "CallExpression" && callee.callee.type === "MemberExpression" &&
              isEffect(callee.callee.object) && effect.get(callee.callee.object.name) === "Effect" && boundaries.test(property(callee.callee))) {
              return current.arguments.some(argument => walk(argument, "effect", returnKind))
            }
            if (callee.type === "Identifier") {
              if (loggers.has(callee.name) || callee.name === "reject") return true
              if (follow(callee, kind, true)) return true
            }
            if (callee.type === "ArrowFunctionExpression" || callee.type === "FunctionExpression") {
              if (walk(callee, kind, returnKind, true)) return true
            }
            if (callee.type === "MemberExpression") {
              const name = property(callee)
              if (isEffect(callee.object)) {
                if (kind === "effect" && (logs(callee) || FAIL.test(name))) return true
                if (effect.get(callee.object.name) === "Effect" && boundaries.test(name)) {
                  return current.arguments.some(argument => walk(argument, "effect", returnKind))
                }
                if (kind === "effect") {
                  if (name === "gen") return current.arguments.some(argument => walk(argument, "generator", "generator", true))
                  if (name === "sync" || name === "promise" || name === "tryPromise") {
                    return current.arguments.some(argument => walk(argument, "native", "native", true))
                  }
                  // These constructors store their argument as a value, without running it.
                  if (name === "succeed") return false
                  if (name === "all") return walk(current.arguments[0], "collection", returnKind)
                  if (name === "as") return current.arguments.length > 1 && walk(current.arguments[0], "effect", returnKind)
                  if (name === "map") return current.arguments.some((argument, index) =>
                    walk(argument, index === current.arguments.length - 1 ? "native" : "effect", returnKind, index === current.arguments.length - 1))
                  return current.arguments.some(argument => walk(argument, "effect", returnKind, effectCallbacks.test(name)))
                }
              }
              if (name === "pipe" && kind === "effect") {
                return walk(callee.object, "effect", returnKind) ||
                  current.arguments.some(argument => walk(argument, "effect", returnKind))
              }
              if (callee.object.type === "Identifier" && callee.object.name === "Promise" && name === "reject" && kind !== "discard") return true
            }
            // Arguments are evaluated, but a callback passed as a value isn't called.
            return current.arguments.some(argument => walk(argument, "discard", returnKind))
          }
        }
        return Object.entries(current).some(([key, value]) =>
          key !== "parent" && key !== "loc" && key !== "range" &&
          (Array.isArray(value) ? value.some(child => walk(child, "discard", returnKind)) :
            typeof value?.type === "string" && walk(value, "discard", returnKind))
        )
      }
      return walk(node, kind, kind, invoke)
    }

    // Whether an `expected:` marker ends on the line before `line`, sits on it, or is inside `handler`.
    const marked = (line, handler) =>
      source.getAllComments().some((comment) =>
        MARKER.test(comment.value) &&
        (comment.loc.end.line === line - 1 || comment.loc.start.line === line ||
          (handler !== undefined && comment.range[0] >= handler.range[0] && comment.range[1] <= handler.range[1]))
      )

    const check = (node, line, form, handler, effectHandler = false) => {
      handlers.push({ node, line, form, handler, effectHandler })
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
          return check(node, line, `${object.name}.${name} handler`, last, true)
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
        for (const { node, line, form, handler, effectHandler } of handlers) {
          if (marked(line, handler)) continue
          const parts = handler?.type === "ObjectExpression" ? handler.properties.map((entry) => entry.value) : [handler]
          if (parts.every((part) => part !== undefined && observes(part, 0, new Set(), effectHandler))) continue
          context.report({ node, messageId: "unobserved", data: { form } })
        }
      },
    }
  },
}
