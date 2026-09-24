# Core flow declarations

Read the [Smithers maintenance skill](../../../../.agents/skills/smithers-maintenance/SKILL.md) and [core README](README.md) before changing plan construction. Planning executes trusted JavaScript in the caller process; placement and effect metadata do not sandbox it. Keep agent-generated declarations behind a validated data-only translator or an externally isolated planner.
