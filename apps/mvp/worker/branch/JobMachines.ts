import { Config, Effect, Option, Schema } from "effect"

// The job machines a deployment declares beside its default one (decision 0128 (c), docs/features/ci.md#machines): each
// is its own container class, with its own image and instance type, and its own Durable Object class
// (worker/BranchSandboxes.ts). A branch names one in `SandboxBranch.machine`; a name the deployment didn't declare wakes
// nothing. Today there is one, `gate`, declared only when GATE_IMAGE is set: a deployment without it has only the
// default machine.

/** The gate's machine: the gate image on GATE_INSTANCE. */
export const GATE = "gate"

/** Cloudflare Containers' named instance types, as `SANDBOX_INSTANCE` and `GATE_INSTANCE` take them. */
export const Instance = Schema.Literals(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"])
export type Instance = typeof Instance.Type

/**
 * `GATE_IMAGE`: the gate machine's prebuilt image, a registry reference by digest
 * (`registry.cloudflare.com/<account>/smithers-gate@sha256:…`). Unset or empty, the deployment has no gate machine.
 */
export const gateImage = Config.option(Config.String("GATE_IMAGE")).pipe(
  Config.map(Option.filter((image) => image.trim() !== "")),
)

/** `GATE_INSTANCE`: the instance type the gate machine starts on, `standard-4` unless set (4 vCPU, 12 GiB, 20 GB). */
export const gateInstance = Config.schema(Instance, "GATE_INSTANCE").pipe(Config.withDefault("standard-4" as const))

/**
 * The job machines this deployment declared, by name: `["gate"]` with GATE_IMAGE, else `[]`. A plan that names any
 * other machine is refused before it runs.
 */
export const declared: Effect.Effect<ReadonlyArray<string>, Config.ConfigError> = Effect.map(
  gateImage,
  Option.match({ onNone: () => [], onSome: () => [GATE] }),
)

/** Whether `machine` is the default machine (none named) or one the deployment declared. */
export const isDeclared = (machines: ReadonlyArray<string>, machine: string | undefined): boolean =>
  machine === undefined || machines.includes(machine)
