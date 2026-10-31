---
"@smthrs/cli": minor
---

`smthrs runner` sends each job's transcript to its host while the agent works, so a person can watch it live. Every
`session/update` is scrubbed, bounded and written to the job's spool under `stateDir/spool/` before it is posted to
`/api/runners/events`, at most once a second; the host answers the next event it lacks, and the runner sends again from
there, so an outage of the host or a restart of the runner loses nothing. The history an agent replays when it loads a
session is not sent twice. A new step of `runner/Job`, `runner/Transcript`, writes the session's end and drains the
spool beside the settlement, which never waits for it.
