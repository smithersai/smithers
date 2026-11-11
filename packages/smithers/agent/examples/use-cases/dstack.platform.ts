/**
 * Host access for the dstack example: the process environment, reading the
 * endpoint from it, and direct-run detection.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"

/**
 * The process environment `main` reads by default.
 *
 * @since 0.1.0
 */
export const environment: Readonly<Record<string, string | undefined>> = process.env

/** Where dstack serves the model: the service's `/v1` URL and a dstack user token. */
export interface Endpoint {
  readonly baseUrl: string
  readonly apiKey: string
}

/**
 * Reads the endpoint from `KIMI_BASE_URL` and `KIMI_API_KEY`, and throws, as 0.x did, when either is missing.
 *
 * @since 0.1.0
 * @throws {Error} when either variable is missing or empty
 */
export const endpointFromEnv = (env: Readonly<Record<string, string | undefined>>): Endpoint => {
  const baseUrl = env["KIMI_BASE_URL"]
  const apiKey = env["KIMI_API_KEY"]
  if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
    throw new Error(
      "Set KIMI_BASE_URL to the dstack service's /v1 URL and KIMI_API_KEY to a dstack user token (`dstack run get kimi-k2 --json` lists the URL)."
    )
  }
  return { baseUrl, apiKey }
}

/**
 * Reads the endpoint when run. A missing variable is a defect carrying the original error.
 *
 * @since 0.1.0
 */
export const endpointOf = (env: Readonly<Record<string, string | undefined>>): Effect.Effect<Endpoint> =>
  Effect.sync(() => endpointFromEnv(env))

/**
 * Runs `program` on the JSON input from the command line and prints its result when `moduleUrl` is the entry module.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const runWhenEntry = <I, A, E>(moduleUrl: string, program: (input: I) => Effect.Effect<A, E>): void => {
  if (moduleUrl !== `file://${process.argv[1]}`) return
  Effect.runPromise(program(JSON.parse(process.argv[2] ?? "{}") as I)).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error("FAILED:", error)
      process.exitCode = 1
    }
  )
}
