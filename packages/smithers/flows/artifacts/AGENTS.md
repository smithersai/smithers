# Artifact storage

Read the [Smithers maintenance skill](../../../../.agents/skills/smithers-maintenance/SKILL.md) and [artifact README](README.md) before changing persistence. The filesystem backend needs trusted host filesystem semantics; published deletion is explicit, and engine-store owns the liveness mark. Preserve exact-byte reads and crash-orphan recovery.
