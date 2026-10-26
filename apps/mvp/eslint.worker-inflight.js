// A factory called during layer construction can escape into every request. Treat all
// Worker factories conservatively: a local function is not proof of request ownership.
const factories = {
  Cache: new Set(["make", "makeWith"]),
  Deferred: new Set(["make", "makeUnsafe"]),
  ScopedCache: new Set(["make", "makeWith"]),
  RcMap: new Set(["make"]),
  RcRef: new Set(["make"]),
  Pool: new Set(["make", "makeWithTTL", "makeWithStrategy"]),
  Effect: new Set(["cached", "cachedWithTTL", "cachedInvalidateWithTTL"]),
}
const property = (node) => node.computed ? node.property.value : node.property.name
const pure = (node) => node?.type === "Literal" ||
  (node?.type === "ArrayExpression" && node.elements.every(pure)) ||
  (node?.type === "ObjectExpression" && node.properties.every((entry) =>
    entry.type === "Property" && !entry.computed && entry.kind === "init" && pure(entry.value)))

export const noSharedInflight = {
  meta: {
    type: "problem",
    schema: [],
    messages: { shared: "worker.request-owned-io: {{name}} can share in-flight I/O between requests when retained by a module or layer. Keep completed values in storage and create I/O in each request. Only cached Effect.succeed of literal constants is allowlisted." },
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
    const check = (node, callee, value) => {
      const name = nameOf(callee)?.replace(/^effect\./, "")
      if (!name) return
      const [owner, method] = name.split(".")
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
          } else if (/^effect\/(Cache|Deferred|Effect|ScopedCache|RcMap|RcRef|Pool)$/.test(source)) {
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
