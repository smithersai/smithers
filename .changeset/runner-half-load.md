---
"@smthrs/agent": minor
"@smthrs/cli": minor
---

Runners admit jobs by their own machine.

- `smthrs runner` claims only while its smoothed one-minute load, plus each job it claimed in the last two minutes, is
  under `admission.loadPerCpu` of its CPUs (0.5) and its disk keeps `admission.diskFloorGb` free (40). A held or full
  runner still claims with `free: 0`, so its machine facts stay current, and says why as `machine.held`
  (`load 31/24`, `disk 31G/40G`).
- `AgentRunner.Machine` gains `held`.
