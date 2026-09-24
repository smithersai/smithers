# Durable engine storage

Read the [Smithers maintenance skill](../../../../.agents/skills/smithers-maintenance/SKILL.md), [engine README](../engine/README.md), and [store README](README.md) before changing persistence. Preserve the single engine decision model and the store's transactional journal/state boundary; migrations precede SQL-backed service startup. Verify replay and recovery against the actual durable store.
