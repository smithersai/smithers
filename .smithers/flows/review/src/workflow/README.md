# Workflow

Typed review actions and child rounds run in the normal caller-owned engine. Review, independent verification and optional narration use host model aliases and budgets. Module implementations require the normal host services; they do not construct a runtime. `reviewActions.ts` holds the declarations and pure steps and imports no platform module; `reviewHostActions.ts` holds the two steps that read a checkout or write a file.
