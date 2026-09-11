/*
 * A command's principal belongs to its binding, not to the time its promise
 * happens to be running. Browser promises have no async-local actor slot.
 * Keep user and agent closures over fixed contexts while sharing the store,
 * transports and controller lifetime. Agent closures are acquired lazily.
 */
const sources = new WeakMap<object, object>()
const state = new WeakMap<object, Map<string, unknown>>()

/** Actor projections share cancellation epochs, subscriptions and watch state. */
export const actorSharedState = <T>(context: object, name: string, create: () => T): T => {
  const source = sources.get(context) ?? context
  let values = state.get(source)
  if (values === undefined) { values = new Map(); state.set(source, values) }
  if (!values.has(name)) values.set(name, create())
  return values.get(name) as T
}

export const createActorBindings = (onDispose: (finalizer: () => void) => void) => {
  const counterparts = new WeakMap<Function, () => Function>()

  const select = <T>(value: T): T => {
    if (typeof value === "function") return (counterparts.get(value)?.() ?? value) as T
    if (value === null || typeof value !== "object") return value
    return new Proxy(value, {
      get: (target, property, receiver) => {
        const member = Reflect.get(target, property, receiver)
        return typeof member === "function" ? select(member) : member
      }
    })
  }

  const agentContext = <C extends object>(context: C): C => {
    const local = new Map<PropertyKey, unknown>()
    const projection = new Proxy(context, {
      get: (target, property, receiver) => {
        if (property === "commandActor") return "smithers"
        if (property === "actor") return () => "smithers"
        if (local.has(property)) return local.get(property)
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? select(value) : value
      },
      set: (target, property, value) => {
        // Late-bound controller callbacks stay local to this principal;
        // mutable runtime state (turns, epochs) still has one authority.
        if (property === "commandActor") throw new Error("A command actor is immutable")
        if (typeof value === "function") {
          local.set(property, value)
          return true
        }
        return Reflect.set(target, property, value)
      }
    })
    sources.set(projection, sources.get(context) ?? context)
    return projection
  }

  const pair = <C extends object, T extends object>(
    context: C,
    factory: (context: C, select: <A>(value: A) => A) => T
  ): T => {
    const user = factory(context, (value) => value)
    let agent: T | undefined
    const agentValue = (): T => {
      if (agent === undefined) {
        agent = factory(agentContext(context), select)
        const dispose = Reflect.get(agent, "dispose")
        if (typeof dispose === "function") onDispose(() => dispose())
      }
      return agent
    }
    for (const key of Reflect.ownKeys(user)) {
      const value = Reflect.get(user, key)
      if (typeof value === "function") {
        counterparts.set(value, () => Reflect.get(agentValue(), key) as Function)
      }
    }
    return user
  }

  return { pair, select }
}
