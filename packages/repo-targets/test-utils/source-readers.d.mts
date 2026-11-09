/** Whether `path` names a TypeScript or VibeLang source (.ts, .tsx, .vibe, .vibex), not a declaration file. */
export declare const isSource: (path: string) => boolean

/**
 * The absolute path of module `path`: the file itself, or, for an absent .ts or .tsx, the .vibe or .vibex beside it
 * (`vibelang/source`'s resolveSource). Throws when neither exists.
 */
export declare const modulePath: (path: string | URL) => string

/**
 * Every source under `directory`, recursively, as paths relative to it with `/` separators, in sorted order: .ts,
 * .tsx, .vibe and .vibex files, but no declaration files and nothing under node_modules. `skip` drops a relative
 * path, a directory's with everything in it.
 */
export declare const sourcesUnder: (directory: string | URL, skip?: (relativePath: string) => boolean) => Array<string>

/** Module `path`'s text as written, resolved as modulePath does. For a reader that looks for text, not syntax. */
export declare const sourceText: (path: string | URL) => string

/**
 * Module `path`'s text in TypeScript: a TypeScript file as written; a VibeLang module as the TypeScript projection
 * VibeLang gives linters (`vibelang --ts-projection`), which keeps its text and lowers VibeLang's own forms, so
 * `try e` reads `(yield* $run(e))`. For a reader that walks a TypeScript syntax tree. The projection decides from the
 * one file: it may rewrite a member call on a name it takes for a service (`try Users.find(id)` reads
 * `$use(Users).find(id)`). Resolves `path` as modulePath does.
 */
export declare const typeScriptOf: (path: string | URL) => string
