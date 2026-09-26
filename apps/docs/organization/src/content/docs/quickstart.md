---
title: "Quickstart"
description: "Run a local organization host, or load the example organization, validate it, and compose one role prompt."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/organization/docs/quickstart.md"
---

This page runs an organization on one machine, then shows the library calls
underneath: loading the example organization, validating it, and composing
the builder's prompt for one task.

## Run a local organization

On macOS (Apple silicon) or Linux with KVM, from a Smithers checkout. Every
agent command runs in a Microsandbox microVM.

```sh
pnpm install
cargo +1.98.0 build --release --locked -p smithers-ffi --bin smithers-jj-export
node flows/organization/cli.ts init ~/org
codex login                              # ChatGPT subscription, for openai:* seats
# edit ~/.smithers/org/.env: SMITHERS_ORG_REPOS=example/demo=<git checkout>
node flows/organization/cli.ts doctor
node flows/organization/cli.ts serve
```

`init` copies the four-role example to `~/org/Org` and writes
`~/.smithers/org/.env` (mode 600). The name before `=` is the one the roles'
`grants.repositories` hold; `doctor` fails on a name no workspace role holds. Seats run on your subscriptions: ChatGPT
through `codex login`, Claude through the Claude Code login (`claude`).
`doctor` prints one `PASS`, `SKIP`, or
`FAIL` line per prerequisite with its fix. `serve` runs the host in the
foreground on `127.0.0.1:7433`; Ctrl-C stops it and runs resume at the next
start. From another terminal:

```sh
node flows/organization/cli.ts submit "Add a line to README.md" --wait
node flows/organization/cli.ts status
node flows/organization/cli.ts answer <gate> approve
```

An approved change lands on an `organization/…` branch of the repository and
is never pushed; its receipt is under `Org/Runs/`. Machines have no network
and hold only the committed files, so builders and checks cannot install
dependencies ([#1931](https://github.com/smithersai/smithers/issues/1931)). Slack intake and the
subscription options are in `flows/organization/setup/QUICKSTART.md` and
`flows/organization/host.md`.

## Load and validate

The library needs Node 26.4 or later and runs without a model.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Prompt, Roster, Skills } from "@smthrs/organization"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const program = Effect.gen(function*() {
  const roster = yield* Roster.load("example/Org")
  const pack = yield* Skills.loadPack("example/Org/Skills")
  const violations = Roster.validate([...roster.profiles.values()], {
    weeklyMeeting: true,
    skills: [...pack.skills.keys()]
  })
  if (violations.length > 0) return yield* Effect.fail(violations)

  const builder = roster.profiles.get("builder")!
  const skills = yield* Effect.fromResult(Skills.select(pack, builder.skills))
  return yield* Effect.fromResult(Prompt.compose({
    common: { id: "common", version: "1", text: "Follow your charter." },
    profile: builder,
    task: {
      id: "task-1",
      objective: "Make slugify keep digits between words.",
      inputs: ["src/slug.js"],
      acceptance: ["slugify('Release 2 Notes') returns 'release-2-notes'"],
      evidence: ["test command output"],
      requestedBy: "lead"
    },
    skills,
    context: []
  }))
})

const composed = await Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
)
console.log(composed.digest, composed.system.length)
```

`composed.system` holds the common instructions, the rendered charter, and
each skill; `composed.prompt` holds the task. `composed.digest` pins the
exact parts, so the same inputs always give the same digest.

## Your own organization

Copy `example/Org` to a private repository, edit the roles, and run the same
validation. Keep credentials out of profiles: a profile names connections
and identities by reference, and a value shaped like a provider token is
refused.
