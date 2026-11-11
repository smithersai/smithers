// The platform code of accounts.vibe: the rotators' state files, live process checks and the operator's home.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

/** One subscription pool. */
export interface Pool {
  readonly ready: ReadonlyArray<string>
  readonly unavailable: ReadonlyArray<{ readonly label: string; readonly state: string }>
  readonly active?: Readonly<Record<string, number>>
}

/**
 * The live per-account cap the rotators enforce (`RR_MAX_PER_ACCOUNT`, default 6).
 * @throws {never}
 */
export function configuredPerAccount(): number {
  const configured = Number(process.env.RR_MAX_PER_ACCOUNT ?? "6")
  return Number.isSafeInteger(configured) && configured >= 1 ? configured : 6
}

/**
 * The operator's home directory.
 * @throws {never}
 */
export function homeDirectory(): string {
  return homedir()
}

/** Counts live rotator jobs; remote sweep runs reserve separately below. */
export const liveAccounts = (state: unknown, alive: (pid: number) => boolean): Record<string, number> => {
  if (typeof state !== "object" || state === null || !("active" in state)) return {}
  const active = state.active
  if (typeof active !== "object" || active === null || Array.isArray(active)) throw new Error("invalid active accounts")
  return Object.fromEntries(
    Object.entries(active).map(([account, pids]) => {
      if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
        throw new Error("invalid account jobs")
      }
      return [account, pids.filter(alive).length]
    })
  )
}

/** `rr status` omits model cooldowns. Apply both scopes before reserving a slot. */
export const cooledPool = (pool: Pool, state: unknown, model: string, now = Date.now() / 1000): Pool => {
  if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("invalid account state")
  const cool = "cool" in state ? state.cool : {}
  if (typeof cool !== "object" || cool === null || Array.isArray(cool)) throw new Error("invalid account cooldowns")
  const unavailable = [...pool.unavailable]
  const ready = pool.ready.filter((account) => {
    for (const key of [account, `${account}@${model}`]) {
      if (!(key in cool)) continue
      const entry: unknown = (cool as Record<string, unknown>)[key]
      if (
        typeof entry !== "object" || entry === null || !("until" in entry) ||
        typeof entry.until !== "number" || !Number.isFinite(entry.until)
      ) throw new Error("invalid account cooldown")
      if (entry.until > now) {
        unavailable.push({ label: account, state: `cooling (${key})` })
        return false
      }
    }
    return true
  })
  return { ...pool, ready, unavailable }
}

/** Whether a process with `pid` exists (or is not ours to signal). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * `pool` with the rotator's cooldowns applied and its live jobs counted, from
 * `~/.smithers/accounts/<agent>-rr.json`; a missing file is an empty state.
 */
export const withAccountState = async (agent: "codex" | "claude", pool: Pool, model: string): Promise<Pool> => {
  const text = await readFile(`${homedir()}/.smithers/accounts/${agent}-rr.json`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}"
    throw error
  })
  const state: unknown = JSON.parse(text)
  const active = liveAccounts(state, alive)
  return { ...cooledPool(pool, state, model), active }
}
