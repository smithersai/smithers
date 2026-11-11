---
"@smthrs/cli": minor
---

Local lanes report their own progress through workstreams.

- `runner.json` takes `workstreams`: per id, a `title`, a `goal`, `criteria` and the planned `tasks`. A key that is not
  lowercase letters, digits and `-`, or a task id planned twice, refuses the file.
- `smthrs runner start --workstream <w> --task <t> [--title <text>]` makes the lane an owner of that task.
- `smthrs runner status --config runner.json` shows each workstream's tasks, the lanes on them and its progress, folded
  from the queued requests and each lane's run: no agent writes a status. `--format json` prints the same data.
