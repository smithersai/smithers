---
"@smthrs/cli": minor
---

`smthrs runner` hosts coding-agent lanes on its own machine when `runner.json` names no `origin`.

- `smthrs runner start <brief> --config runner.json --profile <p> --repository <id>` queues a lane: one-shot, or
  `--standing` for a new round after each one until it is cancelled. `--base` is resolved with jj in the repository's
  mirror, its `main` unless set; a standing lane fetches the mirror and resolves it again before each next round. The request waits under the runner's state directory while `serve` is down.
- `smthrs runner serve` then runs one process: a run-capable control host for the lanes root (`lanes.root`, the state
  directory unless set) with the `lane` module, a job store of its own under `<state>/jobs/`, and the claim loop. Each
  lane is a control run that `smthrs runs list|show|logs|steer|cancel --root <lanes root>` reads and drives; a cancel
  stops the agent's process tree and removes its checkout. A daemon killed or stopped mid-job resumes the lane with no
  `runs resume`.
- A runner job whose execution the runner's journal woke after a restart, before the claim loop had the job back,
  died "ran without its job's control" and never settled. Its work now waits for its control.

A `runner.json` with an `origin` behaves as before.
