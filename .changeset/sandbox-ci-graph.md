---
"@smthrs/sandbox": patch
---

`CiJob`: a job may name its `machine` and the jobs it `needs`; `CiJob.Graph` (`ci/graph`) runs a job graph in waves and
skips a job whose need didn't pass. `CiJob.Machine`'s `checkout`, `run` and `release` take a `JobRef` (`{ name,
machine? }`) instead of the job's name.
