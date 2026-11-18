import { digestSync } from "@smthrs/crypto"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Zig from "../../../src/closure/zig/index.ts"
import type { Closure } from "../../../src/contract/Closure.ts"
import type { CloseEntries } from "../../../src/contract/Parts.ts"

/** The strategy's `close` is contract 10's `CloseEntries`. Checked when the tests are compiled. */
export const close: CloseEntries<FileSystem.FileSystem | Path.Path | ChildProcessSpawner | EffectDigest.Digest> =
  Zig.close

/**
 * The paths of a closure's files.
 *
 * @throws {never}
 */
export const paths = (closure: Closure): ReadonlyArray<string> => closure.files.map((file) => file.path)

/**
 * The SHA-256 of a text, as 64 hex digits.
 *
 * @throws {never}
 */
export const sha256 = (text: string): string => digestSync(text)
