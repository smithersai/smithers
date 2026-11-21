/**
 * The live output bound holds even when the writer re-enters the observer.
 *
 * A long multi-line secret value is held until it closes and is then released
 * together with the lines that followed it, as one batch. A writer that feeds
 * more output back into the observer while that batch prints must not let the
 * rest of the batch print past the bound: the rest waits for the close, where the
 * view ends with its last lines.
 */
import { expect, it } from "vitest"
import * as OutputStream from "../src/OutputStream.ts"

const limit = "… live output limit reached; captured task output is unchanged\n"

it("holds a released batch at the bound after a re-entrant write reached it, until the close", () => {
  const lines: Array<string> = []
  let reentered = false
  const observer: OutputStream.Observer = OutputStream.make({
    maximumLines: 3,
    write: (stream, text) => {
      lines.push(`${stream}:${text}`)
      if (reentered) return
      reentered = true
      observer.onStderr(Buffer.from("r1\nr2\nr3\n"))
    }
  })
  // More held lines than the redactor re-checks eagerly, so the closed value
  // is released with the lines after it.
  const held = ["{\"password\": \"s3cret", ...Array.from({ length: 20 }, (_, index) => `part-${index}`), "\"}"]
  const after = Array.from({ length: 12 }, (_, index) => `after-${index}`)
  observer.onStdout(Buffer.from(`${[...held, ...after].join("\n")}\n`))
  // One redacted value line, the re-entrant lines up to the bound, the notice,
  // and nothing from the rest of the batch while the tool runs.
  expect(lines).toEqual([
    "stdout:{\"password\": \"[REDACTED]\"}\n",
    "stderr:r1\n",
    "stderr:r2\n",
    `stderr:${limit}`
  ])
  observer.close()
  expect(lines.slice(4)).toEqual(["stderr:r3\n", ...after.map((line) => `stdout:${line}\n`)])
  expect(lines.join("")).not.toContain("s3cret")
})
