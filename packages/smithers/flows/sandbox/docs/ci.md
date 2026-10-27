CI machine results may include bounded `output: { stdout, stderr, truncated }`.
The command action seals it with its own `StepResult`, separate from diagnostic
logs. Consumers render the final step's streams, not all prior step results.

Each stream is bounded to 4 KiB of encoded JSON before sealing; larger output is
marked truncated. Later command outcomes carry earlier outcome metadata without
copying earlier output. Each command's own sealed outcome retains its records.
