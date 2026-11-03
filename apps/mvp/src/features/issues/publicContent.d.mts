/** The shared public-content rule (publicContent.mjs). */
export declare const CREDENTIAL_SHAPES: ReadonlyArray<RegExp>
export declare const HOME_PATH: RegExp
export declare const escapeMarkdown: (text: string) => string
export declare const titleProblem: (title: string) => "markup" | undefined
export declare const formsOf: (text: string) => ReadonlyArray<string>
export declare const occurrences: (pattern: RegExp, text: string) => Map<string, number>
export declare const revealed: (pattern: RegExp, form: string, base: string) => boolean
export declare const contentProblem: (text: string) => "credential" | "home_path" | undefined
export declare const hasJwt: (text: string) => boolean
export declare const GITHUB_BODY_LIMIT: number
export declare const attribution: (agent: string, lane: string) => string
export declare const fitsGitHub: (text: string, agent: string, lane: string) => boolean
