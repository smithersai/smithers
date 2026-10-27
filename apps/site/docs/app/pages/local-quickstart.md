---
title: "Run agents on your Mac"
summary: "Install smthrs, have a coding agent change a small project on your Codex subscription, check the change and push it yourself."
---

This page has a coding agent change a small project on your Mac, on your own Codex subscription. You check the change and push it with your own tools. Smithers doesn't land it.

**Before you start:**

- Node.js at the version [Install Smithers](https://smithers.sh/docs/installation/) names. Check yours with `node --version`.
- Jujutsu (`jj`) and `jq`. On macOS with Homebrew: `brew install jj jq`.
- A Codex login on this Mac.

## 1. Install smthrs

```sh
npm install -g smthrs@next
smthrs --version
smthrs doctor
```

`smthrs --version` prints `1.0.0-rc.15` or later. `smthrs doctor` checks project discovery, providers and tools.

## 2. Create a project

Tell Jujutsu who you are, with your own name and email:

```sh
jj config set --user user.name 'Your Name'
jj config set --user user.email you@example.com
```

Then create a small project:

```sh
mkdir slug
cd slug
printf '{"name":"slug","type":"module","scripts":{"test":"node --test"}}\n' > package.json
printf 'export const name = "slug"\n' > index.js
jj git init .
jj describe -m 'Initial tiny project'
jj new
```

## 3. Add the coding flow

```sh
smthrs generate flow coding
```

The generated `.smithers/flows/coding/flow.ts` already sets both `seat` and `model` to `"openai:gpt-6-sol"`. Keep these defaults for Codex. Keep credentials out of the file.

Use your Codex login instead of an API key:

```sh
export SMITHERS_OPENAI_AUTH=chatgpt
unset ANTHROPIC_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY
```

## 4. Ask for a change

```sh
smthrs flow start coding --data '{"args":"Add an exported slugify(text) function to index.js with tests in index.test.js using node:test and node:assert/strict. Lowercase text, replace spaces with hyphens, remove punctuation, trim hyphens. Actually write code and tests, run node --test. Do not commit, approve, merge, land or move main."}'
```

The command waits while the coding agent works, about a minute for this change, then prints the run's ID:

```text
_tag: Accepted
receiptId: "approve:plan-1"
runId: run-1
```

Follow the run with the ID your command printed:

```sh
smthrs runs show run-1
```

Continue when it shows `status: completed`. If the run failed or stopped, `smthrs runs show run-1` says why. If the process running the flow dies, `smthrs runs resume run-1` continues the same run.

## 5. Check the change

```sh
smthrs change diff
node --test
```

The diff includes the files `smthrs generate flow coding` added (`.gitignore` and `.smithers/flows/coding/`), the new `index.test.js` and the change to `index.js`. Read all of it. Your agent may write different code and a different number of tests.

## 6. Commit and push yourself

Replace the path with your repository's remote. Skip `jj git remote add` when `origin` already exists. These commands are for Jujutsu 0.46 or later (`jj --version`).

```sh
jj git remote add origin /path/to/your/origin.git
jj describe -m 'Add slugify'
jj bookmark set main -r @
jj new
jj git push --remote origin --bookmark main
```

Follow your repository's branch and pull request policy when it requires review before `main`.

## Result

A coding agent changed your project on your Codex subscription, and you checked the change and pushed it yourself.

## Next steps

- [What a flow is](flows.md): change how the coding flow works.
- [Quickstart](quickstart.md): open a repository on smithers.sh.
