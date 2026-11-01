/**
 * Half-load admission: whether the runner's host may take another job now.
 *
 * The runner, not the host, decides (decision 0144): it claims only while its
 * machine is over its disk floor and its load is under `loadPerCpu` of its
 * CPUs. The load it compares is the one-minute load average smoothed over
 * {@link SMOOTHING_SECONDS}, so one spike neither holds nor frees the host, plus
 * `jobLoad` for each job it claimed in the last {@link RAMP_SECONDS}, fading as
 * that job's own load has time to show. A held runner says why, as
 * `load 31/24` or `disk 31G/40G`.
 *
 * @since 1.0.0
 */

import type * as Machine from "./Machine.ts"

/**
 * The share of the CPUs the load stays under, the free gigabytes the runner
 * keeps, and the load one new job is counted as until its own load shows.
 *
 * @category models
 * @since 1.0.0
 */
export interface Policy {
  readonly loadPerCpu: number
  readonly diskFloorGb: number
  readonly jobLoad: number
}

/**
 * The policy when `runner.json` sets none: half the CPUs, 40 GB free, one CPU
 * for each new job.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaults: Policy = { loadPerCpu: 0.5, diskFloorGb: 40, jobLoad: 1 }

/**
 * The time constant, in seconds, of the smoothing over load readings.
 *
 * @category constants
 * @since 1.0.0
 */
export const SMOOTHING_SECONDS = 30

/**
 * How long, in seconds, a job the runner just claimed counts toward the load:
 * fully at its claim, then less each second, as the one-minute average has
 * time to show it.
 *
 * @category constants
 * @since 1.0.0
 */
export const RAMP_SECONDS = 120

/**
 * The smoothed load and when it was read, and when each recent claim was
 * made, in epoch milliseconds.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  readonly load?: number | undefined
  readonly at?: number | undefined
  readonly claims: ReadonlyArray<number>
}

/**
 * A runner that has read nothing yet.
 *
 * @category constants
 * @since 1.0.0
 */
export const initial: State = { claims: [] }

/**
 * The state after this reading, and why the host is held, when it is.
 *
 * @category models
 * @since 1.0.0
 */
export interface Decision {
  readonly state: State
  readonly held?: string | undefined
}

const tenths = (value: number): string => String(Math.round(value * 10) / 10)

/**
 * Decides at `nowMs` from `reading`. A fact the machine couldn't read holds
 * nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decide = (policy: Policy, state: State, reading: Machine.Reading, nowMs: number): Decision => {
  let load = state.load
  let at = state.at
  if (reading.load1 !== undefined) {
    const elapsed = at === undefined ? Infinity : Math.max(0, nowMs - at) / 1000
    const weight = 1 - Math.exp(-elapsed / SMOOTHING_SECONDS)
    load = load === undefined ? reading.load1 : load + (reading.load1 - load) * weight
    at = nowMs
  }
  const claims = state.claims.filter((claimed) => nowMs - claimed < RAMP_SECONDS * 1000)
  const next: State = { load, at, claims }
  if (reading.diskFreeGb !== undefined && reading.diskFreeGb < policy.diskFloorGb) {
    return { state: next, held: `disk ${Math.floor(reading.diskFreeGb)}G/${tenths(policy.diskFloorGb)}G` }
  }
  if (load === undefined) return { state: next }
  const pending = claims.reduce(
    (total, claimed) => total + policy.jobLoad * (1 - (nowMs - claimed) / (RAMP_SECONDS * 1000)),
    0
  )
  const limit = policy.loadPerCpu * reading.cpus
  const estimate = load + pending
  return estimate >= limit ? { state: next, held: `load ${tenths(estimate)}/${tenths(limit)}` } : { state: next }
}

/**
 * The state after the runner claimed a job at `nowMs`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claimed = (state: State, nowMs: number): State => ({ ...state, claims: [...state.claims, nowMs] })
