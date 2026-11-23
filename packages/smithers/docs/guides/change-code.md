# Change your code with a flow

Run a coding agent locally on your own subscription, inspect every changed line, run the tests yourself, and push with your own VCS tools. Smithers never approves, commits, or lands this change (a [person-only local landing route](https://github.com/smithersai/smithers/issues/4261) is planned).

```text
+--------------------------------------------------+      +-------------------------------+
| AGENT ZONE (durable SQLite journal in .flows/)   |      | YOUR REVIEW & SHIP            |
|                                                  |      |                               |
|  1. smthrs generate flow coding                  |      |  3. smthrs change diff        |
|           |                                      |      |            |                  |
|           v                                      |      |            v                  |
|  2. smthrs flow start coding (your subscription) | ---> |  4. node --test               |
|           |                                      |      |            |                  |
|           v                                      |      |            v                  |
|  Working copy edits only (no commit, no push)    |      |  5. jj / git commit & push    |
+--------------------------------------------------+      +-------------------------------+
```

## 1. Install `smthrs`

Require Node.js 22.19.0 or later and Jujutsu (`jj`); see [Installation](../installation.md) for platform instructions.

```bash
npm install -g smthrs@next
smthrs --version
```

The tested prerelease prints `1.0.0-rc.15` or later.

## 2. Create a tiny sandbox project

Set up a minimal ES module repository with one file and a clean base commit:

```bash
mkdir slug
cd slug
printf '{"name":"slug","type":"module","scripts":{"test":"node --test"}}\n' > package.json
printf 'export const name = "slug"\n' > index.js
jj git init .
jj config set --repo user.name 'Docs Test User'
jj config set --repo user.email docs@example.invalid
jj describe -m 'Initial tiny project'
jj new
```

Substitute your own name and email (or start inside an existing repository). Prefer Git? Replace the `jj` lines above with:

```bash
git init -b main
git config user.name 'Docs Test User'
git config user.email docs@example.invalid
git add .
git commit -m 'Initial tiny project'
```

> **Using Git?** Smithers computes diffs through `jj` even inside Git repos. Run `jj git init --colocate .` before continuing.

## 3. Generate the coding flow and select your subscription

Scaffold `.smithers/flows/coding/flow.ts` inside the repository:

```bash
smthrs generate flow coding
```

Open `.smithers/flows/coding/flow.ts` and set both `seat` and `model` to `"openai:gpt-6.1-sol"` for Codex, or `"opus"` for Claude. Never put credentials in source files.

To use an existing local Codex login without API keys:

```bash
export SMITHERS_OPENAI_AUTH=chatgpt
unset ANTHROPIC_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY
```

No subscription connected yet? Complete [Installation](../installation.md#requirements) first. The Codex path below was tested on a Pro subscription; the Claude path was not executed during this walkthrough.

## 4. Ask the coding agent for a change

Hand the flow a specific, testable prompt and an explicit stop boundary:

```bash
smthrs flow start coding --data '{"args":"Add an exported slugify(text) function to index.js with tests in index.test.js using node:test and node:assert/strict. Lowercase text, replace spaces with hyphens, remove punctuation, trim hyphens. Actually write code and tests, run node --test. Do not commit, approve, merge, land or move main."}'
```

The command attaches while the agent writes code and executes tests, then prints the durable receipt and run ID:

```text
_tag: Accepted
receiptId: "approve:plan-2"
runId: run-2
```

Check the settled status using the run ID printed in your terminal:

```bash
smthrs runs show run-2
```

Trimmed output:

```text
runId: run-2
flowId: coding
status: completed
```

Proceed only once you see `status: completed`. If the run failed or parked, `runs show` prints the cause; see [Diagnose a run](./diagnose-a-run.md).

> **What if my terminal dies mid-run?**
> The run lives in `.flows/` on disk, not in your terminal session. Check it with `smthrs runs show <id>` and continue the exact same execution with `smthrs runs resume <id>`.

## 5. Review the diff and run the tests yourself

Never rely on the agent's report alone. Inspect every modified file and run `node --test` directly:

```bash
smthrs change diff
node --test
```

The recorded diff shows `Modified regular file index.js` and `Added regular file index.test.js`, alongside the scaffolded `.smithers/flows/coding/` files. The test summary ends with:

```text
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Read the full diff and confirm the tests cover real edge cases. Your agent's implementation and test count may vary.

## 6. Commit and push yourself

Point `origin` at your remote (skip `remote add` if `origin` already exists). With Jujutsu 0.46 or later (`jj --version`):

```bash
jj git remote add origin /path/to/your/origin.git
jj describe -m 'Add slugify'
jj bookmark set main -r @
jj new
jj git push --remote origin --bookmark main
```

With Git:

```bash
git remote add origin /path/to/your/origin.git
git add .
git commit -m 'Add slugify'
git push -u origin main
```

Replace `/path/to/your/origin.git` with your repository's remote URL, and push to a feature branch if your repository protects `main`.
