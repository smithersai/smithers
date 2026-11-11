---
"@smthrs/build-cli": patch
---

`ci --remote <name>` runs one CI selection across the machines an `S.Remotes` entry declares: it splits the roots as
`--shard` does, ships the workspace tree to each machine, runs `ci` there on that machine's roots with the output
streamed back, and merges every machine's results file into one summary. A lost machine runs its part once more on a
fresh session; a second loss reports the part's roots failed. `--plan` prints each machine's roots.
