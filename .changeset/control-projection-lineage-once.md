---
"@smthrs/cli": patch
---

A run with many rounds no longer slows its host as it grows. Copying the engine's records to the control journal
asked every round of a run for the whole run's rounds, saved state included, on every new record: the square of the
round count in state rows. It now reads a run's rounds once per pass, without their state.
