# Job: label every message where the person states strategy or a spec

The messages below are prompts one person typed into Claude Code and Codex, across the software projects they work on. We are pulling out every prompt in which they specify **strategy** or a **spec**, for any project, so their intent is on record in their own words. Jev, a cheap judge, has already dropped the messages it was sure carry no intent; the rest of one chunk is below. You label them. Your output is ids and labels only; a script joins your ids with the exact text later, so never retype or paraphrase a message.

## Input

The messages follow these instructions. Each message is a block:

```
### <id> | <date time, UTC> | <folder they were in> | s:<session id prefix>
<their message, cut at 2,200 characters>
> (paste 1, N chars) <start of text they pasted in>
```

Messages are grouped by folder and ordered by time, so neighbours with the same `s:` are one conversation.

## Keep a message when it does any of these

- **strategy**: where a project or the company is going and why. Goals, priorities, what to build or not build, order of work, release plans and deadlines, positioning, audience, pricing, naming, how the projects relate to each other.
- **spec**: what a product, feature, language, API, UI, doc or system must do or look like. Requirements, design decisions, acceptance bars, quality bars, architecture rulings, corrections such as "no, it should work like X".
- **process**: a standing rule for how work is done that outlives the task. Tool rules, review rules, delegation, release process, writing style, how agents should behave.

Keep it even when it sits inside a task instruction, as long as it says something durable about what they want or why. Typos and rough wording are normal.

## Drop

- One-off commands with nothing durable: "fix the failing test", "continue", "commit and push", "try again".
- Debugging back-and-forth, error reports, status checks, permission answers.
- Questions asked out of curiosity that state no intent.
- Pasted logs, stack traces, command output.
- Text written by an agent or a tool, not by the person: relayed reports ("From <name>:", "FYI from ..."), handoffs, third-person reports of what the person said, machine-made briefs.
- Test prompts and filler.

When you cannot tell whether a message carries durable intent, keep it and mark it `supporting`.

## Output

Reply with one JSON object per line for each KEPT message, nothing for dropped ones, and no other text:

```
{"id": 12, "kind": "strategy", "strength": "core", "project": "docs-site", "topic": "launch scope", "context": "", "paste": false, "secret": false}
```

- `kind`: `strategy`, `spec` or `process`. Pick the main one.
- `strength`: `core` if it states a goal, principle, requirement or decision clearly enough to act on months later; `supporting` if it is weaker, partial, or mostly a task with some intent in it.
- `project`: the project the message is ABOUT, lowercase. Default to the folder name, and give one project one name even when its folders differ. Use `company` for things about the business, hiring, fundraising or all projects at once, and `agents` for rules about how agents work in general.
- `topic`: 3 to 8 plain words.
- `context`: at most two plain sentences, and only when the message cannot be understood alone (what "it", "this" or "option 2" refers to). Take it from neighbouring messages in the same session first. If that is not enough, read `context/<id>.md` in your working directory: what the assistant said just before that message, when its transcript is still on disk. At most 30 reads. Leave `""` when not needed or not knowable. Never invent.
- `paste`: `true` only when the durable content is in the pasted text and the person wrote that text themselves.
- `secret`: `true` if the message holds a credential, token, password or private key.

## How to work

1. Read every message below, in order. Do not skip any part.
2. Read nothing but `context/<id>.md` files. Run nothing. Change no file. Start no subagents.
3. Reply with the JSON lines only.

## Messages
