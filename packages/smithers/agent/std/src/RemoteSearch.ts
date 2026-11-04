/**
 * The search contract for a tree on another machine, in two round trips.
 *
 * `PortableSearch` asks `FileSystem` one question per directory, per entry
 * and per file. On a machine reached through a transport, such as a
 * benchmark's task container behind `docker exec`, every question is a
 * process start, so one `grep` over a 6,000-file repository is some 20,000 of
 * them. This peer asks the machine's own shell twice instead. `find` lists
 * the tree under the root, leaving out the directories every walk skips, and
 * `tar` returns its `.gitignore` files with the listing. The in-process peer
 * then decides which files the search reads, a second `tar` returns exactly
 * those, and `PortableSearch` answers over that copy. Every result, notice,
 * and refusal is therefore the in-process peer's own: this module decides
 * only where the bytes come from.
 *
 * It runs through the machine's own `ChildProcessSpawner`, the one
 * `Sandbox.hostContext` serves beside the machine's `FileSystem`. The machine
 * needs `sh`, `find`, `xargs`, `tar`, `head`, and `base64`; GNU, BusyBox, and
 * BSD userlands all have them. Output crosses as base64, so a transport whose
 * channel carries only text returns it intact. A search reads at most
 * {@link maxBytes} of file content and refuses beyond that, naming the root
 * to narrow.
 *
 * @since 1.0.0-rc.8
 */

import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect } from "effect"
import * as Base64 from "effect/encoding/Base64"
import * as FileSystem from "effect/FileSystem"
import * as Result from "effect/Result"
import * as Exec from "./internal/Exec.vibe"
import * as Prune from "./internal/Prune.ts"
import * as RemoteTree from "./internal/RemoteTree.vibe"
import * as Tar from "./internal/Tar.ts"
import * as PortableSearch from "./PortableSearch.ts"
import * as Search from "./Search.vibe"
import * as StdError from "./StdError.vibe"

/**
 * The most file content one search brings back from the machine.
 *
 * The copy is held in memory while the in-process peer reads it, so the
 * bound is on this process's memory rather than on the search: a root that
 * holds more is refused with `response_too_large` and a narrower root or
 * globs answer it.
 *
 * @category constants
 * @since 1.0.0-rc.8
 */
export const maxBytes = 256 * 1024 * 1024

/** The most a listing, with its `.gitignore` files, may take. */
const maxListingBytes = 64 * 1024 * 1024

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const pruned = `\\( ${Prune.repositoryDirectories.map((name) => `-name ${quoted(name)}`).join(" -o ")} \\) -prune`

/** The refusal for a machine without one of the tools a search runs. */
const missing = (tool: string) => `searching this machine needs ${tool}, which it does not have`

const requireTools = `for t in find xargs tar head; do command -v "$t" >/dev/null || { ` +
  `echo "${missing("$t")}" >&2; exit 3; }; done`

/**
 * `$1` is the root, `$2` the byte bound, and `$3` is `1` to send the
 * `.gitignore` files after the listing. Records are NUL-terminated `<kind><path>`;
 * an `E` record ends the listing, and a tar stream of the ignore files follows.
 */
const listing = [
  "set -f",
  requireTools,
  "r=$1",
  "{",
  "  if [ -d \"$r\" ]; then if [ -r \"$r\" ] && [ -x \"$r\" ]; then printf 'd%s\\0' \"$r\"; else printf 'u%s\\0' \"$r\"; fi",
  "  elif [ -f \"$r\" ]; then printf 'f%s\\0' \"$r\"",
  "  elif [ -e \"$r\" ]; then printf 'o%s\\0' \"$r\"",
  "  fi",
  // No `-exec … {} +` inside parentheses: BusyBox `find` never runs one there.
  `  find -H "$r" -mindepth 1 ${pruned} -o -type d -exec printf 'd%s\\0' {} + ` +
  `-o -type f -exec printf 'f%s\\0' {} + ` +
  `-o -type l -exec sh -c 'for p do if [ -d "$p" ]; then k=D; elif [ -f "$p" ]; then k=F; else k=L; fi; ` +
  `printf "%s%s\\0" "$k" "$p"; done' sh {} + -o -exec printf 'o%s\\0' {} + 2>/dev/null`,
  "  printf 'E\\0'",
  `  if [ "$3" = 1 ]; then find -H "$r" -mindepth 1 ${pruned} -o -type f -name .gitignore -print0 2>/dev/null | ` +
  "(cd / && COPYFILE_DISABLE=1 xargs -0 -r tar -cf - -- 2>/dev/null); fi",
  "} | head -c \"$2\" | base64"
].join("\n")

/** `$1` is the byte bound; standard input is the NUL-terminated absolute paths to send. */
const fetching = [
  requireTools,
  "cd / && COPYFILE_DISABLE=1 xargs -0 -r tar -chf - -- 2>/dev/null | head -c \"$1\" | base64"
].join("\n")

const failed = (root: string, reason: string): StdError.StdError =>
  new StdError.StdError({
    code: "command_failed",
    message: `Could not search ${root} on this machine: ${reason}`,
    path: root
  })

const tooLarge = (root: string, bound: number): StdError.StdError =>
  new StdError.StdError({
    code: "response_too_large",
    message: `The files under ${root} come to more than ${bound} bytes; narrow the root or the globs`,
    path: root
  })

/**
 * Reads the program from the first line of standard input, as base64, and
 * runs it with the arguments and the rest of standard input. A program in
 * the argv would be quoted once by the spawner and again by the transport,
 * and a sealed host refuses to start a command line past 4,096 characters;
 * this line stays short whatever the program says.
 */
const bootstrap = `command -v base64 >/dev/null || { echo "${missing("base64")}" >&2; exit 3; }; ` +
  "IFS= read -r p && p=$(printf %s \"$p\" | base64 -d) && exec sh -c \"$p\" sh \"$@\""

/**
 * Runs one script on the machine and decodes the base64 it prints, refusing
 * output that reached `bound`: `head` cut it, so it is not the whole answer.
 */
const run = (
  root: string,
  script: string,
  args: ReadonlyArray<string>,
  bound: number,
  stdin = ""
): Effect.Effect<Uint8Array, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const result = yield* Exec.exec("sh", {
      args: ["-c", bootstrap, "sh", ...args],
      stdin: `${Base64.encode(new TextEncoder().encode(script))}\n${stdin}`
    }).pipe(Effect.mapError((error) => failed(root, error.message)))
    if (result.exitCode !== 0) {
      return yield* Effect.fail(failed(root, result.stderr.trim() || `exit ${result.exitCode}`))
    }
    const decoded = Base64.decode(result.stdout.replaceAll(/\s/g, ""))
    if (Result.isFailure(decoded)) return yield* Effect.fail(failed(root, "the machine answered with invalid base64"))
    if (decoded.success.length >= bound) return yield* Effect.fail(tooLarge(root, bound - 1))
    return decoded.success
  })

/**
 * Builds the peer over a machine's spawner and its `Path`, which resolves a
 * relative root where the machine's file operations do. `maxBytes` lowers
 * the bound on the file content one search brings back; the default is
 * {@link maxBytes}.
 *
 * @category constructors
 * @since 1.0.0-rc.8
 */
export const make = (
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  options?: { readonly maxBytes?: number | undefined }
): Search.Search => {
  const path = Context.get(services, Path.Path)
  const contentBound = (options?.maxBytes ?? maxBytes) + 1
  const copy = (tree: RemoteTree.Tree) =>
    Context.make(FileSystem.FileSystem, RemoteTree.fileSystem(tree, path)).pipe(Context.add(Path.Path, path))
  const listed = (root: string, noIgnore: boolean | undefined) => {
    const resolved = path.resolve(root)
    const bound = maxListingBytes + 1
    return Effect.flatMap(
      run(root, listing, [resolved, String(bound), noIgnore === true ? "0" : "1"], bound),
      (bytes) => {
        const tree = RemoteTree.parse(bytes, resolved, path)
        return tree === undefined ? Effect.fail(failed(root, "the listing came back malformed")) : Effect.succeed(tree)
      }
    )
  }
  return Search.make({
    grep: (input) =>
      Effect.gen(function*() {
        const tree = yield* listed(input.root, input.noIgnore)
        const read = yield* PortableSearch.searched(input).pipe(Effect.provide(copy(tree)))
        const files = [...new Set(read.map((file) => path.resolve(file)))]
        const bytes = files.length === 0 ? new Uint8Array() : yield* run(
          input.root,
          fetching,
          [String(contentBound)],
          contentBound,
          files.map((file) => `${file}\0`).join("")
        )
        // `tar` ends every archive it writes, even one whose files it could not read.
        const members = files.length === 0 || bytes.length > 0 ? Tar.files(bytes) : undefined
        if (members === undefined) return yield* Effect.fail(failed(input.root, "the files came back malformed"))
        const contents = new Map([...tree.contents, ...RemoteTree.absolute(members)])
        return yield* PortableSearch.make(copy({ ...tree, contents })).grep(input)
      }).pipe(Effect.provide(services)),
    glob: (input) =>
      Effect.flatMap(listed(input.root, input.noIgnore), (tree) => PortableSearch.make(copy(tree)).glob(input)).pipe(
        Effect.provide(services)
      )
  })
}
