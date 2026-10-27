// Discover the real Alchemy resource graph; provider lifecycle methods never execute.
import { Stack } from "alchemy/Stack"
import * as Output from "alchemy/Output"
import { Effect, Redacted } from "effect"
import ElectricGateway from "../ElectricGateway.ts"
import { DatabaseUrl } from "../ElectricRuntime.ts"

export const discover = async (databaseUrl?: Output.Output<Redacted.Redacted<string>>) => {
  const stack = Stack.of({ name: "smithers-mvp", stage: "test", resources: {}, bindings: {}, actions: {} })
  const declaration = databaseUrl === undefined ? ElectricGateway
    : ElectricGateway.pipe(Effect.provideService(DatabaseUrl, { value: databaseUrl }))
  // Provider requirements are phantom during discovery: no lifecycle/provider operation is run.
  // Discard the Resource before crossing Promise resolution; Alchemy Outputs can otherwise look thenable.
  await Effect.runPromise(declaration.pipe(
    Effect.provideService(Stack, stack),
    Effect.asVoid,
    Effect.scoped,
    Effect.timeout("5 seconds"),
  ) as unknown as Effect.Effect<unknown, unknown>)
  return stack
}

