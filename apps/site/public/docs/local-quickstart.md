# Run agents on your Mac

> Hands-on tutorial: install smthrs, let a coding agent build and test a feature on your Codex subscription, inspect the diff, and push it yourself.

Suppose you want a coding agent to implement a real function with unit tests in a local repository, using your existing Codex subscription instead of juggling API keys, and without ever letting the agent touch `git push` or move `main`.

That is what we are building in this tutorial. You will create a tiny Node project (`slug`), drop a Smithers coding flow into it, launch a durable run, inspect the working-copy diff, run the tests, and commit the result yourself.

```text
+-------------------------------------------------+     +-------------------------------+
| AGENT ZONE (local, durable, resumable)          |     | YOUR CHECK & SHIP             |
|                                                 |     |                               |
| 1. smthrs generate flow coding                  |     | 3. smthrs change diff         |
|         |                                       |     |         |                     |
|         v                                       |     |         v                     |
| 2. smthrs flow start coding (Codex login)       | --> | 4. node --test                |
|         |                                       |     |         |                     |
|         v                                       |     |         v                     |
| .flows/ SQLite journal --> Working copy (jj @)  |     | 5. jj describe & jj git push  |
|   (Crash? smthrs runs resume <id>)              |     |                               |
| [AGENT STOPS HERE: no commit, no push]          |     +-------------------------------+
+-------------------------------------------------+
```

_The local coding loop: smthrs runs the coding agent durably through SQLite and stops at the working copy so you inspect, test, and push_

## What you need before starting

- **Node.js 22.19.0 or later** (check with `node --version`; see [Install Smithers](https://smithers.sh/docs/installation/) for platform notes).
- **Jujutsu (`jj`) and `jq`:** on macOS with Homebrew, run `brew install jj jq`.
- **An active Codex login** on this Mac.

## Step 1. Install `smthrs` and verify the machine

Install the 1.0 release candidate from npm and run `doctor` before touching any code:

```sh
npm install -g smthrs@next
smthrs --version
smthrs doctor
```

`smthrs --version` prints `1.0.0-rc.15` or later. `smthrs doctor` checks Node, `jj`, flow discovery, and provider credentials without modifying your disk. Fix any `fail` line before moving on.

## Step 2. Build a tiny sandbox project

First, tell Jujutsu who you are (replace with your own name and email):

```sh
jj config set --user user.name 'Your Name'
jj config set --user user.email you@example.com
```

Now create a minimal ES module project with one file and an initial commit:

```sh
mkdir slug
cd slug
printf '{"name":"slug","type":"module","scripts":{"test":"node --test"}}\n' > package.json
printf 'export const name = "slug"\n' > index.js
jj git init .
jj describe -m 'Initial tiny project'
jj new
```

Why `jj new` at the end? That leaves your initial commit cleanly sealed and gives the coding agent a fresh working-copy change (`@`) to edit.

## Step 3. Add the coding flow and point it at Codex

Generate a starter coding flow inside the repository:

```sh
smthrs generate flow coding
```

This creates `.smithers/flows/coding/flow.ts` and adds `.flows/` to `.gitignore`. The generated file already sets both `seat` and `model` to `"openai:gpt-6-sol"`. Keep those defaults for Codex, and keep credentials out of source files.

Now tell Smithers to route OpenAI seats through your local ChatGPT/Codex login and clear any API keys from this shell:

```sh
export SMITHERS_OPENAI_AUTH=chatgpt
unset ANTHROPIC_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY
```

:::note[There are no dumb questions]
**Q: Why unset the API keys?**
A: Smithers picks your Codex subscription cleanly when `SMITHERS_OPENAI_AUTH=chatgpt` is set and no provider API keys compete in the environment. A failed subscription never silently falls back to billing an API key.

**Q: Why does the flow live inside `.smithers/flows/` instead of my home directory?**
A: Because a flow is part of your repository's engineering contract. Committing `.smithers/flows/coding/flow.ts` lets teammates and CI run the exact same typed workflow.
:::

## Step 4. Launch the coding agent

Give the flow a concrete, verifiable task and an explicit boundary ("do not commit or push"):

```sh
smthrs flow start coding --data '{"args":"Add an exported slugify(text) function to index.js with tests in index.test.js using node:test and node:assert/strict. Lowercase text, replace spaces with hyphens, remove punctuation, trim hyphens. Actually write code and tests, run node --test. Do not commit, approve, merge, land or move main."}'
```

The command attaches while the agent plans, writes code, and runs tests (about a minute for this task), then prints the durable receipt and run ID:

```text
_tag: Accepted
receiptId: "approve:plan-1"
runId: run-1
```

Inspect the finished run using the `runId` your terminal printed:

```sh
smthrs runs show run-1
```

Wait until you see `status: completed`. If a run fails or stops early, `smthrs runs show run-1` prints the diagnosis.

:::tip[Under the hood: crash-safe by default]
Every step of that run is journaled inside `.flows/` (SQLite). If your terminal closes or you kill the process mid-run, the work is not lost. Run `smthrs runs resume run-1` to pick up the exact same execution where it stopped.
:::

## Step 5. Inspect the diff and run the tests yourself

Never trust an agent's summary alone. Read the full diff and execute the test suite directly:

```sh
smthrs change diff
node --test
```

Your diff will contain:
- `.gitignore` and `.smithers/flows/coding/` from Step 3,
- edits to `index.js` adding `slugify(text)`, and
- the new `index.test.js` test suite.

Read every line. Confirm the tests actually exercise edge cases (punctuation, leading/trailing spaces, uppercase) and pass under `node --test`.

## Step 6. Commit and push with your own tools

Once you are satisfied with the code, commit and push with Jujutsu (0.46 or later; check `jj --version`). Replace `/path/to/your/origin.git` with your real remote, or skip `jj git remote add` if `origin` already exists:

```sh
jj git remote add origin /path/to/your/origin.git
jj describe -m 'Add slugify'
jj bookmark set main -r @
jj new
jj git push --remote origin --bookmark main
```

If your repository requires pull requests before `main`, push to a feature bookmark instead and open a PR as usual.

## What you just proved

- You ran a coding agent locally on your own Codex subscription with zero API keys in the repository.
- Every step executed through a typed, resumable flow recorded in `.flows/`.
- The agent stopped cleanly at the working copy; you verified the diff, ran the tests, and owned the commit.

## Next steps

- Understand why flows plan first and skip unchanged steps on rerun: [How durable flows work](https://smithers.sh/docs/durable-flows/).
- Learn how to edit, pin, and test custom flows in `.smithers/flows/`: [Flows reference](https://smithers.sh/docs/flows/).
- Explore repositories in the hosted web app: [Quickstart](https://smithers.sh/docs/quickstart/).
