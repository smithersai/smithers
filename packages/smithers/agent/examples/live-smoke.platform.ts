/**
 * Host access for the live smoke examples: the process environment and
 * direct-run detection.
 *
 * @since 0.1.0
 */
import { Effect } from "effect"

/**
 * The process environment the examples hand to the egress HTTP client.
 *
 * @since 0.1.0
 */
export const environment: NodeJS.ProcessEnv = process.env

/**
 * Reads one environment variable.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const envVar = (name: string): string | undefined => process.env[name]

/**
 * Builds and runs `program` and prints its result when `moduleUrl` is the entry module.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const runWhenEntry = <A, E>(moduleUrl: string, program: () => Effect.Effect<A, E>): void => {
  if (moduleUrl !== `file://${process.argv[1]}`) return
  Effect.runPromise(program()).then(
    (result) => {
      console.log("RESULT:", JSON.stringify(result))
    },
    (error) => {
      console.error("FAILED:", error)
      process.exitCode = 1
    }
  )
}
