/**
 * The `cloudflare:workers` module as the tests see it.
 *
 * Only workerd resolves the real one. `worker/AppSession.ts` needs exactly one
 * thing from it, the `DurableObject` base class, and that class does nothing
 * but keep the state and bindings it was constructed with. The vitest configs
 * alias the specifier here so the Durable Object can be constructed on Node
 * over the storage `./durableObject.ts` provides.
 */
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env
  ) {}
}
