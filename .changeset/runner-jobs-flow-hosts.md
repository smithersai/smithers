---
"@smthrs/cli": minor
---

A flow host on a local runner's machine can run external agent steps on that runner. `RunnerJobs.layer(configPath)`
from `@smthrs/cli/RunnerJobs` is the `AgentJobs` over the runner's state directory: a start or cancel is a request file
that `smthrs runner serve` admits into its own store each poll, and a step reads its job's own file.
`RunnerJobs.layerFromEnvironment` reads the path from `SMITHERS_RUNNER_CONFIG`.
