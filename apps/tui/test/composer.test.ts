/** Where a submitted composer line goes. */
import { describe, expect, it } from "bun:test"
import * as Composer from "../src/composer.ts"

describe("route", () => {
  it("sends a plain line to the agent, a / line to commands and a ! line to the shell", () => {
    expect(Composer.route("fix the test", false)).toEqual({ _tag: "prompt" })
    expect(Composer.route("/model", false)).toEqual({ _tag: "command" })
    expect(Composer.route("!ls", false)).toEqual({ _tag: "shell", command: "ls", excluded: false })
    expect(Composer.route("!!ls", false)).toEqual({ _tag: "shell", command: "ls", excluded: true })
  })

  it("steers a worker with anything but a shell line or a command", () => {
    expect(Composer.route("also check refresh", true)).toEqual({ _tag: "steer" })
    expect(Composer.route("/chat", true)).toEqual({ _tag: "command" })
    expect(Composer.route("!ls", true)).toEqual({ _tag: "shell", command: "ls", excluded: false })
  })
})
