import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import { Process } from "../src/internal/Process.ts"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-git-fault-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload: Review.Payload = {
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Report defects",
  engine: "claude",
  model: "fixture",
  batchSize: 1,
  failOn: "error"
}

const faultReview = async (
  fault: {
    readonly base?: string
    readonly paths?: ReadonlyArray<string>
    readonly tree?: string
    readonly blob?: string
    readonly blobStatus?: number
  },
  value = payload
) => {
  const configuration = {
    base: "a".repeat(40),
    paths: ["src/deleted.ts"],
    tree: `100644 blob ${"c".repeat(40)}\tsrc/deleted.ts\0`,
    blob: "content",
    blobStatus: 0,
    ...fault
  }
  const program = Path.join(root, "git-protocol.mjs")
  await Fs.writeFile(
    program,
    `const fault=${JSON.stringify(configuration)};
const args=process.argv.slice(2);
let text="",status=0;
if(args.includes("rev-parse"))text=fault.base+"\\n"+"b".repeat(40)+"\\n";
else if(args.includes("diff"))text=fault.paths.join("\\0")+"\\0";
else if(args.includes("ls-tree"))text=fault.tree;
else if(args.includes("cat-file")){text=fault.blob;status=fault.blobStatus;}
process.stdout.write(text,()=>process.exit(status));
`
  )
  let modelCalls = 0
  const result = await Effect.runPromise(Effect.flip(
    Review.review({
      workspaceRoot: root,
      transport: () => {
        modelCalls++
        return Effect.fail(new Error("inference should not run"))
      }
    }, value).pipe(Effect.provideService(Process, {
      spawn: (options) => {
        if (options.command !== "git") return Effect.die(new Error("only the git fault program may spawn"))
        return ScopedProcess.spawn({ ...options, command: process.execPath, args: [program, ...options.args ?? []] })
      },
      status: ScopedProcess.status
    }))
  ))
  expect(modelCalls).toBe(0)
  return result
}

describe("review git protocol failures", () => {
  it("validates the resolved base before using it as a git operand", async () => {
    const error = await faultReview({ base: "--untrusted-option" })
    expect(error).toMatchObject({ phase: "diff" })
    expect(error.message).toContain("base")
  })

  it("bounds changed paths from a faulty git service before reading files", async () => {
    const paths = Array.from({ length: Review.maximumReviewFiles + 1 }, (_, index) => `src/a${index}.ts`)
    const error = await faultReview({ paths })
    expect(error).toMatchObject({ phase: "diff" })
    expect(error.message).toContain(`more than ${Review.maximumReviewFiles} changed paths`)
  })

  it("maps a glob matcher failure into the diff error channel", async () => {
    const error = await faultReview({}, { ...payload, include: [Input.glob("a".repeat(65537))] })
    expect(error).toMatchObject({ phase: "diff" })
    expect(error.message).toContain("pattern")
  })

  it.each(
    [
      [{ tree: "not-a-tree-entry\0" }, "git ls-tree returned an unusable entry"],
      [{ tree: "" }, "LLM review file disappeared after discovery: src/deleted.ts"],
      [{ blob: "invalid\0text" }, "LLM review file is not usable text"],
      [{ blobStatus: 17 }, "git cat-file exited 17"]
    ] as const
  )("reports an invalid deleted-file read before inference, case %#", async (fault, message) => {
    const error = await faultReview(fault)
    expect(error).toMatchObject({ phase: "read" })
    expect(error.message).toContain(message)
  })
})

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "maps a native Windows module inspection permission failure through the review error channel",
  async () => {
    const directory = Path.join(root, "blocked")
    await Fs.mkdir(directory)
    const executable = Path.join(directory, "reviewer.mjs")
    await Fs.writeFile(executable, "process.stdout.write('unexpected')")
    await Fs.chmod(directory, 0)
    try {
      const error = await Effect.runPromise(Effect.flip(
        Review.promptEngine({ workspaceRoot: root, executable }, {
          engine: "claude",
          model: "fixture",
          prompt: "Review"
        }).pipe(Effect.provideService(Process, {
          platform: "win32",
          spawn: ScopedProcess.spawn,
          status: ScopedProcess.status
        }))
      ))
      expect(error).toMatchObject({ phase: "review" })
      expect(error.message).toContain("EACCES")
    } finally {
      await Fs.chmod(directory, 0o700)
    }
  }
)

it.each([undefined, "host refused launch"])(
  "preserves a platform failure without an Error cause: %s",
  async (description) => {
    const failure = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "spawn",
      ...(description === undefined ? {} : { description }),
      cause: "native host refusal"
    })
    const error = await Effect.runPromise(Effect.flip(
      Review.promptEngine({ workspaceRoot: root, executable: process.execPath }, {
        engine: "claude",
        model: "fixture",
        prompt: "Review"
      }).pipe(Effect.provideService(Process, {
        spawn: () => Effect.fail(failure),
        status: ScopedProcess.status
      }))
    ))
    expect(error).toMatchObject({ phase: "review" })
    expect(error.message).toContain(description ?? failure.message)
  }
)
