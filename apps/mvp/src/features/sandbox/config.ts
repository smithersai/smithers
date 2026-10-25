import { Config, Schema } from "effect"
import { COMMAND_LIMIT_SECONDS } from "./contract"

// The deployment's sandbox settings that its Worker and its build both read (decision 0088: a program's configuration
// is captured when it is built), so the browser's tools state the limits ChatApi holds their calls to. Only Effect
// here, so the build's own config (vite.config.ts) can import it.

/**
 * `SANDBOX_COMMAND_MAX_SECONDS`: the longest command a person or an agent may run on a branch's machine, in whole
 * seconds from 60 (what a command that names no timeout runs, `SandboxTools.limits.defaultTimeoutSeconds`) to
 * `COMMAND_LIMIT_SECONDS`, the job's own limit, which it is unless set. Any other value fails with a `ConfigError`.
 * ChatApi reads it once for `POST /api/sandbox/calls`, the `FlowExecution` object once for the TODO agent's tool, and
 * the build once for the browser's run tool (src/features/sandbox/flows.ts `COMMAND_MAX_SECONDS`), so a value the
 * Worker would refuse fails the build.
 */
export const commandMaxSeconds: Config.Config<number> = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: COMMAND_LIMIT_SECONDS })),
  "SANDBOX_COMMAND_MAX_SECONDS",
).pipe(Config.withDefault(COMMAND_LIMIT_SECONDS))
