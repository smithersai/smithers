// Decision 0017 §9, enforced where the mutation is rather than where one entry point's middleware is.
//
// H4: an approval decision is refused to a delegate inside `Launch.approve` and `Launch.deny`, which every door
// reaches: the canonical `approvals approve`, the legacy flat `approve` in `Command.ts`, and the real executable with
// an inherited mark. H5: a delegate never sends the person's saved login, and never adds or deletes an account SSH key.
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService } from "@smthrs/control"
import { Cause, Effect, Exit, Layer } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as Delegate from "../src/Delegate.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { resources } from "../src/internal/backend/Resources.ts"
import { Session } from "../src/internal/backend/Session.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import { packageVersion } from "../src/Version.ts"
import { processBudget, runIn, temporaryDirectoryPrefix } from "./support/bin.ts"

const refusal = (command: string) => ({
  _tag: "/cli/Refused",
  fault: "policy",
  code: "person_only",
  message: `smthrs ${command} needs a person. An agent can propose it; a person runs it from their own terminal.`
})

/** A control plane that records every member anything asks it for. A refused decision asks for none. */
const watchedControl = () => {
  const touched: Array<string> = []
  const control = new Proxy({}, {
    get: (_target, key) => {
      touched.push(String(key))
      return () => Effect.die(new Error(`the control plane was reached: ${String(key)}`))
    }
  }) as unknown as ControlService.Control["Service"]
  return { touched, layer: Layer.succeed(ControlService.Control, control) }
}

const failureOf = async (effect: Effect.Effect<unknown, unknown, never>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return Cause.squash(exit.cause)
}

const as = (principal: Delegate.Principal, control: Layer.Layer<ControlService.Control>) =>
(
  effect: Effect.Effect<unknown, unknown, any>
): Effect.Effect<unknown, unknown, never> =>
  effect.pipe(
    Effect.provideService(Delegate.Principal, principal),
    Effect.provide(control),
    Effect.provide(Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)),
    Effect.provide(NodeServices.layer)
  ) as Effect.Effect<unknown, unknown, never>

describe("H4: the approval mutation itself refuses a delegate", () => {
  it.each(
    [
      ["approvals approve", () => Launch.approve("{}", "run", true)],
      ["approvals deny", () => Launch.deny("{}", true)]
    ] as const
  )("%s is person_only before the payload is read or the control plane is asked", async (command, decide) => {
    const { layer, touched } = watchedControl()
    const error = await failureOf(as("agent", layer)(decide()))
    expect(error).toBeInstanceOf(CliError.Refused)
    const refused = error as CliError.Refused
    expect({ _tag: refused._tag, fault: refused.fault, code: refused.code, message: refused.message })
      .toEqual(refusal(command))
    expect(touched).toEqual([])
  })

  it.each(
    [
      ["approve", ["approve", "{}"]],
      ["approve --scope", ["approve", "{}", "--scope", "remembered"]],
      ["deny", ["deny", "{}"]],
      ["--json approve", ["--json", "approve", "{}"]]
    ] as const
  )("the legacy `%s` in Command.ts reaches the same refusal and never settles", async (_name, argv) => {
    const { layer, touched } = watchedControl()
    const error = await failureOf(as("agent", layer)(Command.runWith(cli, { version: packageVersion })(argv)))
    expect(error).toBeInstanceOf(CliError.Refused)
    expect((error as CliError.Refused).code).toBe("person_only")
    expect(touched).toEqual([])
  })

  it("a person passes the check: the same calls fail on the malformed payload instead", async () => {
    for (const decide of [() => Launch.approve("not json", "run", true), () => Launch.deny("not json", true)]) {
      const { layer } = watchedControl()
      const error = await failureOf(as("person", layer)(decide()))
      expect(error).toBeInstanceOf(CliError.UsageError)
    }
    const { layer } = watchedControl()
    const legacy = await failureOf(
      as("person", layer)(Command.runWith(cli, { version: packageVersion })(["approve", "not json"]))
    )
    expect((legacy as { code?: string }).code).not.toBe("person_only")
  })

  it("a marked environment is an agent whatever else it holds, and only the exact mark counts", () => {
    expect(Delegate.principalOf({ [Delegate.DELEGATE_ACT]: "agent" })).toBe("agent")
    expect(Delegate.principalOf({ [Delegate.DELEGATE_ACT]: "agent", SMITHERS_AUDIENCE: "human" })).toBe("agent")
    expect(Delegate.principalOf({})).toBe("person")
    expect(Delegate.principalOf({ [Delegate.DELEGATE_ACT]: "person" })).toBe("person")
    // The process's own mark is not undone by a host-supplied environment.
    const before = process.env[Delegate.DELEGATE_ACT]
    process.env[Delegate.DELEGATE_ACT] = "agent"
    try {
      expect(Delegate.principalOf({})).toBe("agent")
    } finally {
      if (before === undefined) delete process.env[Delegate.DELEGATE_ACT]
      else process.env[Delegate.DELEGATE_ACT] = before
    }
  })
})

describe("H4: the real executable refuses an inherited delegate mark at both entries", processBudget, () => {
  const inherited = { [Delegate.DELEGATE_ACT]: "agent" }
  const invoke = (args: ReadonlyArray<string>, environment: Readonly<Record<string, string>>) => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const child = runIn(cwd, args, environment)
      return {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
        state: existsSync(join(cwd, ".flows"))
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  // `--json` and `--quiet` keep the flat spelling on the legacy entry (`cli/LegacyBin.ts` and `Command.ts`).
  it.each(
    [
      ["approve --json", ["approve", "{}", "--json"]],
      ["deny --json", ["deny", "{}", "--json"]],
      ["approve --quiet", ["approve", "{}", "--quiet"]],
      ["deny --quiet", ["deny", "{}", "--quiet"]]
    ] as const
  )("legacy `smthrs %s` exits 1 with person_only and opens no store", (_name, argv) => {
    const child = invoke(argv, inherited)
    expect(child.status, child.stderr).toBe(1)
    expect(child.stderr).toContain("person_only: smthrs")
    expect(child.stderr).toContain("needs a person")
    expect(child.stdout).toBe("")
    expect(child.state).toBe(false)
  })

  // A piped flat spelling with no such flag is an agent's: `bin.ts` rewrites it to the canonical command.
  it.each(
    [
      ["approve", ["approve", "{}"]],
      ["deny", ["deny", "{}"]],
      ["approve --scope", ["approve", "{}", "--scope", "remembered"]]
    ] as const
  )("the flat alias `smthrs %s` exits 1 with person_only and opens no store", (_name, argv) => {
    const child = invoke(argv, inherited)
    expect(child.status, child.stderr).toBe(1)
    expect(child.stdout + child.stderr).toContain("person_only")
    expect(child.stdout + child.stderr).toContain("needs a person")
    expect(child.state).toBe(false)
  })

  it.each(
    [
      ["approvals approve", ["approvals", "approve", "{}", "--json"]],
      ["approvals deny", ["approvals", "deny", "{}", "--json"]]
    ] as const
  )("canonical `smthrs %s` exits 1 with person_only", (command, argv) => {
    const child = invoke(argv, inherited)
    expect(child.status, child.stderr).toBe(1)
    expect(JSON.parse(child.stdout)).toMatchObject({ code: "person_only", message: refusal(command).message })
  })

  it.each([
    [["ssh-key", "add", "--help"], "--title", "Add an SSH key"],
    [["approvals", "approve", "-h"], "--scope", "Approve the exact serialized payload"],
    [["approve", "--help"], "--scope", "Approve the exact serialized payload"]
  ] as const)("scoped help for %j hides person-only details from delegates", (argv, option, description) => {
    const child = invoke(argv, { ...inherited, SMITHERS_AUDIENCE: "human" })
    const output = child.stdout + child.stderr
    expect(output).not.toContain(option)
    expect(output).not.toContain(description)
    expect(child.state).toBe(false)
  })

  it("implicit SSH-key group help shows only delegate commands", () => {
    const child = invoke(["ssh-key"], { ...inherited, SMITHERS_AUDIENCE: "human" })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain("List SSH keys")
    expect(child.stdout).not.toContain("Add an SSH key")
    expect(child.stdout).not.toContain("Delete an SSH key")
  })

  it("the same commands from a person are not refused as person_only", () => {
    for (
      const argv of [["approve", "{}", "--json"], ["deny", "{}", "--json"], ["approvals", "approve", "{}", "--json"]]
    ) {
      const child = invoke(argv, { [Delegate.DELEGATE_ACT]: "" })
      expect(child.status, child.stderr).not.toBe(0)
      expect(child.stdout + child.stderr).not.toContain("person_only")
    }
  })
})

/** A session whose only credential is a saved personal login, from the store `source` names. */
class SavedLogin extends Session {
  readonly from: "keyring" | "smithers_auth_file" | "config"
  constructor(environment: Record<string, string | undefined>, from: "keyring" | "smithers_auth_file" | "config") {
    super(environment)
    this.from = from
  }
  override require(): ReturnType<Session["require"]> {
    return Promise.resolve({ ...this.target(), token: "saved-personal-login", source: this.from }) as never
  }
}

const backend = (
  environment: Record<string, string | undefined>,
  from: "keyring" | "smithers_auth_file" | "config" | undefined
) => {
  const sent: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
  const env = {
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    SMITHERS_API_ORIGIN: "https://api.example.test",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
    ...environment
  }
  const runtime = {
    environment: env,
    stderr: { write: () => {}, isTTY: false, columns: 80 },
    fetch: ((url: string, init: { headers: Record<string, string> }) => {
      sent.push({ url, headers: { ...init.headers } })
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    }) as never
  }
  const client = from === undefined ? new Client(runtime, false) : new Client(runtime, false, new SavedLogin(env, from))
  return { client, sent }
}

describe("H5: a delegate never sends the person's saved login", () => {
  it.each(["keyring", "smithers_auth_file", "config"] as const)(
    "a delegated request with only a %s login fails closed and sends nothing",
    async (from) => {
      const { client, sent } = backend({ [Delegate.DELEGATE_ACT]: "agent" }, from)
      const error = await client.request("GET", "/api/user").then(() => undefined, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(CliError.Refused)
      expect((error as CliError.Refused).fault).toBe("policy")
      expect((error as CliError.Refused).code).toBe("delegate_credential_required")
      expect(sent).toEqual([])
      // A mutation fails the same way, before its body is built.
      await expect(client.request("POST", "/api/user/keys", { title: "t", key: "k" })).rejects.toMatchObject({
        code: "delegate_credential_required"
      })
      expect(sent).toEqual([])
      expect(JSON.stringify(sent)).not.toContain("saved-personal-login")
    }
  )

  it("a delegate sends the credential handed to its own process, and says it acts as an agent", async () => {
    const { client, sent } = backend(
      { [Delegate.DELEGATE_ACT]: "agent", SMITHERS_TOKEN: "issued-for-agent" },
      undefined
    )
    await client.request("GET", "/api/user")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.headers["authorization"]).toBe("token issued-for-agent")
    expect(sent[0]!.headers["Smithers-Act"]).toBe("agent")
    // No caller header removes the statement.
    await client.request("GET", "/api/user", undefined, { headers: { "Smithers-Act": "person" } })
    expect(sent[1]!.headers["Smithers-Act"]).toBe("agent")
  })

  it("a person still uses the saved login, with no agent statement", async () => {
    const { client, sent } = backend({}, "keyring")
    await client.request("GET", "/api/user")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.headers["authorization"]).toBe("token saved-personal-login")
    expect(sent[0]!.headers).not.toHaveProperty("Smithers-Act")
  })
})

describe("H5: account SSH keys are changed by a person only", () => {
  it.each(
    [
      ["ssh-key add", {}, { title: "laptop", key: "ssh-ed25519 public" }],
      ["ssh-key delete", { id: 4 }, {}]
    ] as const
  )("the %s handler refuses a delegate before any request", async (name, args, options) => {
    const { client, sent } = backend(
      { [Delegate.DELEGATE_ACT]: "agent", SMITHERS_TOKEN: "issued-for-agent" },
      undefined
    )
    const request = vi.spyOn(client, "request")
    await expect(resources[name]!(client, args, options)).rejects.toMatchObject(refusal(name))
    expect(request).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it("a person's ssh-key add and delete still reach the API with the saved login", async () => {
    const { client, sent } = backend({}, "keyring")
    await resources["ssh-key add"]!(client, {}, { title: "laptop", key: "ssh-ed25519 public" })
    await resources["ssh-key delete"]!(client, { id: 4 }, {})
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.example.test/api/user/keys",
      "https://api.example.test/api/user/keys/4"
    ])
    expect(sent.every((request) => request.headers["authorization"] === "token saved-personal-login")).toBe(true)
  })
})
