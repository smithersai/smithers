// A flow a person runs by hand from the test repository's runs page (apps/mvp/e2e/actions.spec.ts): its form takes a
// greeting and how long to wait, and its one job prints the greeting, waits, and prints it again.
import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

/** `text` as one shell word, quoted so the shell runs nothing in it. */
const quoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`

export default Flow.make("hand", {
  description: "Run by hand: print a greeting, wait, print it again.",
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String,
    greeting: Schema.String.annotate({ title: "Greeting" }),
    wait: Schema.Literals(["1", "300"]).annotate({ title: "Wait", default: "1" }),
  },
  success: CiJob.Result,
  body: (run: { readonly greeting: string; readonly wait: string }) =>
    CiJob.make("greet", {
      steps: [
        { name: "hello", run: `echo ${quoted(run.greeting)}` },
        { name: "wait", run: `sleep ${run.wait === "300" ? 300 : 1}` },
        { name: "again", run: `echo ${quoted(run.greeting)} again` },
      ],
    }).call(run),
})
