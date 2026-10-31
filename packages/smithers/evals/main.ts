// The eval without vitest, for a machine that has the agents' logins but not this repository's install: bundle this
// file (esbuild, platform node) and run it with AGENT_STEER_PROFILES set. Prints each trial as a JSON line; exits 1
// when any failed.
import * as AgentSteerCli from "./agentSteerCli.ts"

const trials = await AgentSteerCli.run()
for (const trial of trials) process.stdout.write(`${JSON.stringify(trial)}\n`)
process.exit(trials.every((trial) => trial.pass) ? 0 : 1)
