---
title: "TypeScript API Reference"
description: "Programmatic Effect, Smithers Flows, and Smithers Targets API exported by smithers-comments."
---

# TypeScript API Reference

`smithers-comments` exports clean, composable modules built on `effect` (`4.x`), `@smthrs/flows`, and `@smthrs/targets`.

```ts
import {
  Agent,
  Anchor,
  Cache,
  Cli,
  Config,
  Extract,
  Flows,
  Lexer,
  Sidecar,
  Targets,
  targets,
  Validator,
  VirtualFile
} from "smithers-comments"
```

## `Config`

- `Config.CommentsConfig` — Effect `Schema` for `.smithers/comments.json`.
- `Config.defaultConfig` — default configuration object.
- `Config.ConfigError` — `Schema.TaggedError("smithers-comments/ConfigError")`.
- `Config.parseConfig(raw: string): Effect.Effect<CommentsConfig, ConfigError>`
- `Config.loadConfig(cwd: string, configPath?: string): Effect.Effect<{ config: CommentsConfig; configPath: string; exists: boolean }, ConfigError>`
- `Config.validateCommentsDir(dir: string): Effect.Effect<string, ConfigError>`

## `Lexer`

- `Lexer.LanguageFamily` — `"c-style" | "hash" | "dash" | "markup"`
- `Lexer.CommentStyle` — `"line" | "block" | "doc"`
- `Lexer.LexedComment` — `{ id, style, raw, body, startOffset, endOffset, startLine, endLine, startColumn, endColumn, isInline, isPragma, anchorLine, indentation }`
- `Lexer.LexResult` — `{ language, comments, lineCount, eol, hasTrailingNewline }`
- `Lexer.detectLanguage(filePath: string): LanguageFamily | undefined`
- `Lexer.isPragmaComment(raw: string, body: string, startLine: number, extraPatterns?: ReadonlyArray<RegExp>): boolean`
- `Lexer.lexComments(source: string, filePath: string, options?: { preservePragmas?: boolean; extraPragmaPatterns?: ReadonlyArray<string> }): LexResult`
- `Lexer.stripProseComments(source: string, filePath: string, options?: { preservePragmas?: boolean; extraPragmaPatterns?: ReadonlyArray<string> }): { code: string; extracted: ReadonlyArray<LexedComment>; preservedPragmas: ReadonlyArray<LexedComment> }`

## `Anchor`

- `Anchor.AnchorSpec` — tagged union:
  - `{ readonly kind: "file" }`
  - `{ readonly kind: "symbol"; readonly symbol: string }`
  - `{ readonly kind: "line"; readonly line: number }`
  - `{ readonly kind: "pattern"; readonly pattern: string }`
- `Anchor.ResolvedAnchor` — `{ readonly line: number; readonly codeRegion: string; readonly codeHash: string }`
- `Anchor.AnchorError` — `Schema.TaggedError("smithers-comments/AnchorError")` with `reason: "dangling-anchor" | "ambiguous-anchor"`
- `Anchor.extractSymbols(source: string, language: Lexer.LanguageFamily): ReadonlyArray<{ name: string; line: number; params: ReadonlyArray<string> }>`
- `Anchor.computeCodeHash(codeRegion: string): string` — returns 8 lowercase hex characters.
- `Anchor.extractCodeRegion(source: string, line: number, placement: Sidecar.Placement): string`
- `Anchor.resolveAnchor(source: string, language: Lexer.LanguageFamily, anchor: AnchorSpec, placement: Sidecar.Placement, lineHint?: number): Effect.Effect<ResolvedAnchor, AnchorError>`
- `Anchor.inferAnchor(source: string, language: Lexer.LanguageFamily, comment: Lexer.LexedComment): { anchor: AnchorSpec; line: number; placement: Sidecar.Placement; codeHash: string }`

## `Sidecar`

- `Sidecar.Placement` — `"before" | "inline" | "after"`
- `Sidecar.SidecarEntry` — `{ id, anchor, line?, placement, style, codeHash?, body }`
- `Sidecar.SidecarDocument` — `{ source, version: 1, entries: ReadonlyArray<SidecarEntry> }`
- `Sidecar.SidecarParseError` — `Schema.TaggedError("smithers-comments/SidecarParseError")`
- `Sidecar.sidecarPathFor(commentsDir: string, sourceRelPath: string): string`
- `Sidecar.sourcePathFromSidecar(commentsDir: string, sidecarRelPath: string): string | undefined`
- `Sidecar.parseSidecar(content: string, filePath?: string): Effect.Effect<SidecarDocument, SidecarParseError>`
- `Sidecar.formatSidecar(doc: SidecarDocument): string`

## `VirtualFile`

- `VirtualFile.VirtualFile` — `{ path, content, digest, sourceDigest, commentsDigest, injectedCount, lineMap }`
- `VirtualFile.VirtualFileTree` — `{ files: ReadonlyMap<string, VirtualFile>; treeDigest: string }`
- `VirtualFile.VirtualFileProjectionError` — `Schema.TaggedError("smithers-comments/VirtualFileProjectionError")`
- `VirtualFile.projectFile(source: string, sidecar: Sidecar.SidecarDocument | undefined, filePath: string, options?: { onUnresolved?: "fail" | "skip" }): Effect.Effect<VirtualFile, VirtualFileProjectionError>`
- `VirtualFile.projectTree(sources: ReadonlyMap<string, string>, sidecars: ReadonlyMap<string, Sidecar.SidecarDocument>, options?: { onUnresolved?: "fail" | "skip" }): Effect.Effect<VirtualFileTree, VirtualFileProjectionError>`
- `VirtualFile.materializeTree(tree: VirtualFileTree, outDir: string, options?: { check?: boolean }): Effect.Effect<{ written: ReadonlyArray<string>; drifted: ReadonlyArray<string> }, VirtualFileProjectionError>`

## `Cache`

- `Cache.CacheKeyInput` — `{ path, language, mode, commentId, commentStyle, commentBody, anchoredCodeRegion, rubric, modelId }`
- `Cache.CacheVerdict` — `{ ok: boolean; diagnostics: ReadonlyArray<Validator.Diagnostic>; suggestedBody?: string; updatedAt: string }`
- `Cache.computeCacheKey(input: CacheKeyInput): string` — deterministic SHA-256 hex string.
- `Cache.CommentCacheStore` — Effect `Context.Service` with `get`, `set`, `size`, `flush`.
- `Cache.memoryCacheLayer(): Layer.Layer<CommentCacheStore>`
- `Cache.fileCacheLayer(cacheFilePath: string): Layer.Layer<CommentCacheStore>`

## `Agent`

- `Agent.ValidationRequest` — `{ path, language, commentId, commentStyle, commentBody, anchoredCodeRegion, rubric, modelId }`
- `Agent.ValidationResponse` — `{ ok: boolean; diagnostics: ReadonlyArray<Validator.Diagnostic>; suggestedBody?: string }`
- `Agent.AgentError` — `Schema.TaggedError("smithers-comments/AgentError")`
- `Agent.AgentValidator` — Effect `Context.Service` with `validate(req)` and `fix(req, diagnostics)`.
- `Agent.heuristicLayer: Layer.Layer<AgentValidator>` — zero-network deterministic semantic validator.
- `Agent.noopLayer: Layer.Layer<AgentValidator>` — approves all structurally valid comments without semantic inspection.

## `Validator`

- `Validator.Severity` — `"error" | "warning"`
- `Validator.Diagnostic` — `{ file, line, column, severity, code, commentId?, message }`
- `Validator.validateStructuralInline(...)` — pure Stage 1 inline checks.
- `Validator.validateStructuralExternal(...)` — pure Stage 1 external checks.

## `Flows`

Real `@smthrs/flows` (`Action.make`, `Flow.make`, `Interpreter.layer`) durable workflows:

- `Flows.CheckCommentAction` — Smithers `Action` validating one comment via `AgentValidator`.
- `Flows.FixCommentAction` — Smithers `Action` fixing one comment via `AgentValidator`.
- `Flows.CheckFileFlow` — Smithers `Flow` running structural checks + cache lookup + `CheckCommentAction` on misses.
- `Flows.FixFileFlow` — Smithers `Flow` running checks + `FixCommentAction` on failing comments.
- `Flows.RenderVirtualFlow` — Smithers `Flow` projecting a `VirtualFileTree`.
- `Flows.makeFlowLayer(...)` — registers all comment flows and action implementations into a Smithers `Interpreter.layer`.
- `Flows.runCheckRepository(options)` — runs the full check workflow across a repository, returning `CheckReport`.
- `Flows.runFixRepository(options)` — runs the full fix workflow across a repository, returning `FixReport`.
- `Flows.runExtractRepository(options)` — extracts inline comments to external sidecars, returning `ExtractReport`.
- `Flows.runRenderRepository(options)` — projects (and optionally materializes) virtual files, returning `RenderReport`.

## `Targets` (and top-level `targets`)

- `targets(options: Targets.CommentTargetsOptions)` — returns `{ sources, sidecars, lint, virtualFiles, materialize }` built on `@smthrs/targets` (`Smithers.Filegroup`, `Smithers.Shell.Test`, `Smithers.Generate`, `Smithers.Materialize`).

## `Cli`

- `Cli.runCli(argv: ReadonlyArray<string>, options?: { cwd?: string; stdout?: (s: string) => void; stderr?: (s: string) => void }): Effect.Effect<number>` — returns the process exit code (`0 | 1 | 2 | 3 | 4`).
