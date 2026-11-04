/** The bootstrap Node lease shared with Effect repository flows. */
export const defaultLockTimeoutMs: number
export interface LockOptions {
  timeoutMs?: number
  maxHoldMs?: number
  staleMs?: number
  heartbeatMs?: number
  signal?: AbortSignal
  now?: () => number
  wait?: (ms: number) => Promise<void>
  heartbeat?: boolean
  heartbeatProgram?: string
  onEvent?: (event: { stage: string }) => void
  log?: (line: string) => void
}
export interface LandLease {
  (): Promise<void>
  ticket: string
  check(): void
  push(command: string, args: ReadonlyArray<string>, options?: {
    cwd?: string
    env?: Record<string, string | undefined>
    stream?: boolean
  }): Promise<{ status: number | null; signal?: string | null }>
}
export function acquireLock(path: string, options?: LockOptions): Promise<LandLease>
