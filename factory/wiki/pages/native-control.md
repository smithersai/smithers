# One native control composition

The ordinary Node boundary and private Bun boundary call the same NativeControl factory. That factory composes existing Control, executable registry, AgentSession, native engine and gateway services. Domain flows receive injected services; the Bun boundary does not launch a Node sidecar.

## Keep platform selection at the executable

Each boundary selects its runtime, SQL adapter, JJ adapter, HTTP gateway and model transport. The factory receives those layers instead of choosing a Node or Bun implementation inside a domain operation. Its control database layer is captured and shared in the host composition. Native module execution uses the existing engine database and journal; AgentSession uses the captured Control journal for its surrounding lifecycle.

## Bind module work to its approved owner

ModuleAdmission inspects the existing native run state, associated Control run, approved plan and executable catalog before allowing work. ModuleAuthority checks the approved root around each registered handler and restores the recorded owner and notification queue. Shared root usage is accounted through the native journal-backed budget. A configured executable mismatch refuses adoption; the generic host cannot guess another module's implementation.

These are private host composition boundaries. The product continues to use existing plans, approvals, runs and notifications. See the configured coding host for the separate native adapter and operator policy it supplies.

## Observe execution without replacing its result

EngineJournalSupervisor wraps accepted launch and resume operations, starts native observation in the host scope, and recovers active observations on restart. It projects native journal evidence into the Control journal and records observation-started and observation-settled markers. Those markers describe the reader; they do not replace the underlying execution result. The recursive UI's observation page explains how it consumes that distinction.
