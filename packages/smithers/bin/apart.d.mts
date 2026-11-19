/** The types of `apart.mjs`, for the tests that import it. */

/** The variable that carries the shared cache's token. */
export declare const tokenName: "SMITHERS_CACHE_TOKEN"

/** Tells the second start which descriptor its variables wait at. */
export declare const pipeName: "SMITHERS_START_PIPE"

/** The commands that run a repository's targets. */
export declare const targetCommands: ReadonlySet<string>

/** The variables the second start is started with. */
export declare const startVariables: ReadonlySet<string>

/** The command a start names: its first argument that is not a flag. */
export declare const commandOf: (args: ReadonlyArray<string>) => string | undefined

/** The first program of that name a search path holds, or `undefined`. */
export declare const findProgram: (name: string, searchPath: string | undefined) => string | undefined

/** bubblewrap's arguments before the command. */
export declare const apartArguments: (uid: number | undefined, exists?: (path: string) => boolean) => Array<string>

/** What a start is asked with. */
export interface Start {
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
  readonly uid: number | undefined
}

/** Why a start is not started again, or the bubblewrap that will hold the second one. */
export type Plan =
  | { readonly apart: false; readonly why: string }
  | { readonly apart: true; readonly bwrap: string; readonly wrap: ReadonlyArray<string> }

export declare const plan: (start: Start, starts?: (program: string, wrap: ReadonlyArray<string>) => boolean) => Plan

/** The variables a second start is started with, and the rest, which wait at the pipe. */
export declare const divide: (env: Readonly<Record<string, string | undefined>>) => {
  readonly started: Record<string, string>
  readonly piped: Record<string, string>
}

/** Starts the program again under bubblewrap and resolves to its exit code, or to `undefined`. */
export declare const startApart: (proc?: NodeJS.Process) => Promise<number | undefined>

/** In a second start, takes the variables that wait at the pipe. */
export declare const receive: (
  proc?: { env: Record<string, string | undefined> },
  read?: (descriptor: number) => string
) => void
