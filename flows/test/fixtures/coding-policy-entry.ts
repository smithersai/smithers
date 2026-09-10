import { Effect, FileSystem, Stream } from "effect"
import { runningWikiPolicy } from "../../coding/wiki-policy.ts"

// A deployed artifact must identify itself without reading source files from
// either the installed host or the target repository.
const fs = FileSystem.makeNoop({ stream: () => Stream.die(new Error("Bundled policy attempted a source read")) })
process.stdout.write(`${await Effect.runPromise(runningWikiPolicy.pipe(Effect.provideService(FileSystem.FileSystem, fs)))}\n`)
