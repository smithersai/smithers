/**
 * The Jujutsu-workspace sandbox provider.
 *
 * A `Sandbox.Provider` whose machines are isolated Jujutsu workspaces of a
 * host repository, provisioned through an injected `@smthrs/jj` `Jj` service
 * alongside an injected filesystem, path dialect, and contained process
 * spawner. By default each workspace carries a private, lane-local `.git` view
 * borrowing objects read-only from the repository's shared git store, so stock
 * `Sandbox.run` and `SandboxMerge.Apply` work unchanged without mutating host
 * refs or index. Like `DirectorySandbox`, it is a trusted local workspace
 * boundary and explicitly **not a security boundary**.
 *
 * @since 1.0.0
 */

export * from "./make.ts"
