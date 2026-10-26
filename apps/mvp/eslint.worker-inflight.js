// A factory called during layer construction can escape into every request. Treat all
// Worker factories conservatively: a local function is not proof of request ownership.
// Waiting counts as sharing: a request blocked on a permit, latch, queue or pubsub that
// another request releases is waiting on that request's work (2026-10-25 ReadToken incident).
const queues = ["make", "bounded", "unbounded", "dropping", "sliding"]
const factories = {
  Cache: new Set(["make", "makeWith"]),
  Deferred: new Set(["make", "makeUnsafe"]),
  ScopedCache: new Set(["make", "makeWith"]),
  RcMap: new Set(["make"]),
  RcRef: new Set(["make"]),
  Pool: new Set(["make", "makeWithTTL", "makeWithStrategy"]),
  Effect: new Set(["cached", "cachedWithTTL", "cachedInvalidateWithTTL"]),
  Semaphore: new Set(["make", "makeUnsafe"]),
  TxSemaphore: new Set(["make"]),
  Latch: new Set(["make", "makeUnsafe"]),
  Queue: new Set(queues),
  TxQueue: new Set(queues),
  PubSub: new Set([...queues, "makeAtomicBounded", "makeAtomicUnbounded"]),
  TxPubSub: new Set(queues),
  // Both serialize writers behind a permit; SubscriptionRef publishes through a PubSub.
  SynchronizedRef: new Set(["make", "makeUnsafe"]),
  SubscriptionRef: new Set(["make"]),
}
// A plain Ref is safe; one holding pending work is a shared in-flight lookup.
const refs = new Set(["make", "makeUnsafe"])
const modules = new RegExp(`^effect/(${[...Object.keys(factories), "Ref"].join("|")})$`)
// Types and namespaces whose values are pending work another request could await.
const pendingTypes = new Set(["Effect", "Promise", "PromiseLike", "Deferred", "Fiber"])
const pendingCalls = new Set(["Effect", "Deferred", "Fiber"])
const property = (node) => node.computed ? node.property.value : node.property.name
const pure = (node) => node?.type === "Literal" ||
  (node?.type === "ArrayExpression" && node.elements.every(pure)) ||
  (node?.type === "ObjectExpression" && node.properties.every((entry) =>
    entry.type === "Property" && !entry.computed && entry.kind === "init" && pure(entry.value)))

export const noSharedInflight = {
  meta: {
    type: "problem",
    schema: [],
    messages: { shared: "worker.request-owned-io: {{name}} can make one request wait on another request's work when retained by a module or layer. Keep completed values in storage or a plain Ref, and create waits and I/O in each request. Only cached Effect.succeed of literal constants is allowlisted." },
  },
  create(context) {
    const aliases = new Map()
    const declarations = []
    const calls = []
    const references = []
    const nameOf = (node) => {
      if (node?.type === "Identifier") {
        const variable = context.sourceCode.getScope(node).set.get(node.name)
        // Resolve through lexical scopes, so shadowed imports are not treated as Effect.
        let scope = context.sourceCode.getScope(node)
        while (scope && !scope.set.has(node.name)) scope = scope.upper
        const binding = variable ?? scope?.set.get(node.name)
        return aliases.get(binding)
      }
      if (node?.type === "MemberExpression") {
        const parent = nameOf(node.object)
        return parent ? `${parent}.${property(node)}` : undefined
      }
    }
    const bind = (node, name) => {
      const variable = context.sourceCode.getDeclaredVariables(node)[0]
      aliases.set(variable, name)
    }
    // Whether a type mentions pending work: Effect.Effect<...>, Promise<...>, Fiber.Fiber<...>.
    const pendingType = (node) => {
      if (!node || typeof node !== "object") return false
      if (node.type === "TSTypeReference") {
        let head = node.typeName
        while (head.type === "TSQualifiedName") head = head.left
        if (pendingTypes.has(head.name)) return true
      }
      return Object.entries(node).some(([key, child]) => key !== "parent" &&
        (Array.isArray(child) ? child.some(pendingType) : child?.type?.startsWith("TS") && pendingType(child)))
    }
    // Whether a Ref's initial value holds pending work. A function body is not a value (a thunk makes work per call),
    // and `yield*` or `await` hands over a completed one.
    const pendingValue = (node) => {
      if (!node || typeof node !== "object" || node.type?.includes("Function") ||
        node.type === "YieldExpression" || node.type === "AwaitExpression") return false
      if (pendingType(node.typeArguments) || pendingType(node.typeAnnotation)) return true
      if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Promise") return true
      if (node.type === "CallExpression" || node.type === "MemberExpression") {
        const target = node.type === "CallExpression" ? node.callee : node
        if (pendingCalls.has((nameOf(target)?.replace(/^effect\./, "") ?? "").split(".")[0])) return true
        if (target.type === "MemberExpression" && target.object.type === "Identifier" && target.object.name === "Promise") return true
      }
      return Object.entries(node).some(([key, child]) => key !== "parent" &&
        (Array.isArray(child) ? child.some(pendingValue) : typeof child?.type === "string" && pendingValue(child)))
    }
    const check = (node, callee, value) => {
      const name = nameOf(callee)?.replace(/^effect\./, "")
      if (!name) return
      const [owner, method] = name.split(".")
      if (owner === "Ref" && refs.has(method)) {
        if (node.type === "CallExpression" && (pendingType(node.typeArguments) || pendingValue(value))) {
          context.report({ node, messageId: "shared", data: { name: `${name} of pending work` } })
        }
        return
      }
      if (!factories[owner]?.has(method)) return
      // A completed literal constant cannot own pending I/O.
      if (name === "Effect.cached" && value?.type === "CallExpression" &&
        nameOf(value.callee)?.replace(/^effect\./, "") === "Effect.succeed" && pure(value.arguments[0])) return
      context.report({ node, messageId: "shared", data: { name } })
    }
    const reference = (node) => {
      const parent = node.parent
      if (parent.type === "CallExpression" && parent.arguments.includes(node)) references.push(node)
    }
    return {
      Identifier: reference,
      MemberExpression: reference,
      ImportDeclaration(node) {
        const source = node.source.value
        for (const specifier of node.specifiers) {
          const variable = context.sourceCode.getDeclaredVariables(specifier)[0]
          if (source === "effect") {
            aliases.set(variable, specifier.type === "ImportNamespaceSpecifier" ? "effect" : specifier.imported?.name)
          } else if (modules.test(source)) {
            const part = source.split("/")[1]
            aliases.set(variable, specifier.type === "ImportNamespaceSpecifier" ? part : `${part}.${specifier.imported?.name}`)
          }
        }
      },
      VariableDeclarator(node) {
        declarations.push(node)
      },
      AssignmentExpression(node) {
        if (node.operator === "=" && node.left.type === "Identifier") declarations.push({ id: node.left, init: node.right, assignment: true })
      },
      CallExpression(node) {
        calls.push(node)
      },
      "Program:exit"() {
        // Resolve to a fixed point before checking uses: a closure can refer to an
        // alias declared later, and aliases can themselves form forward chains.
        let previous
        do {
          previous = aliases.size
          for (const node of declarations) {
            const name = nameOf(node.init)
            if (!name) continue
            if (node.assignment) {
              let scope = context.sourceCode.getScope(node.id)
              while (scope && !scope.set.has(node.id.name)) scope = scope.upper
              const variable = scope?.set.get(node.id.name)
              if (variable) aliases.set(variable, name)
            } else if (node.id.type === "Identifier") bind(node, name)
            else if (node.id.type === "ObjectPattern") {
              const variables = context.sourceCode.getDeclaredVariables(node)
              for (const entry of node.id.properties) {
                const local = entry.type === "RestElement" ? entry.argument :
                  entry.value.type === "AssignmentPattern" ? entry.value.left : entry.value
                const variable = variables.find((value) => value.name === local.name)
                if (variable) aliases.set(variable, entry.type === "RestElement" ? name : `${name}.${entry.key.name ?? entry.key.value}`)
              }
            }
          }
        } while (aliases.size !== previous)
        for (const node of calls) check(node, node.callee, node.arguments[0])
        for (const node of references) check(node, node)
      },
    }
  },
}
