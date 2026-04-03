# Smithers TUI v2 — Agent Handoff Document

Welcome to the Smithers TUI v2 implementation team! Your goal is to take the prototype UI and implement full end-to-end functionality using Playwright and Test-Driven Development (TDD).

## 1. Context & Required Reading
Before writing any code or tests, you **must** read and understand the core product philosophy and technical architecture of the V2 TUI. 

Please read the following 4 specification documents thoroughly:
1. `docs/guides/smithers-tui-v2-prd.md` (Product Requirements Document)
2. `docs/guides/smithers-tui-v2-design.md` (Visual Design & Theme Rules)
3. `docs/guides/smithers-tui-v2-engineering.md` (Architecture, State & Broker layout)
4. `docs/guides/smithers-tui-v2-summary.md` (One-page quick summary)

> [!IMPORTANT]  
> The overarching directive is: The TUI is a chat-first Control Plane for Smithers workflows, *not* a basic dashboard. 

## 2. Current State of the Codebase
A foundational mock UI has already been built. **All TUI v2 code is isolated in `src/cli/tui-v2/`** so it does not conflict with the existing legacy TUI.

* **`src/cli/tui-v2/shared/types.ts`**: Contains the central domain models (`Workspace`, `FeedEntry`, etc.) and the event envelope protocol definition.
* **`src/cli/tui-v2/client/`**: Contains the `TuiAppV2` shell, OpenTUI UI components (`Feed`, `TopBar`, `WorkspaceRail`, `Composer`, `Inspector`), and a global `useSyncExternalStore` for state management (`state/store.ts`).
* **`src/cli/tui-v2/broker/MockBroker.ts`**: Contains a mock orchestration layer that currently spits out dummy token streams, tool results, and workflow run updates.
* **`src/cli/tui-v2/index.ts`**: The entrypoint that pairs `MockBroker` with the layout renderer so the visual interface can be evaluated in isolated terminal environments via `bun run src/cli/tui-v2/index.ts`.

## 3. Your Task: E2E TDD Implementation
Your job is to replace the mock behavior with real data binding and implement all TUI interactions following best practices.

**Instructions:**
1. **Use Microsoft Playwright**: The workspace already has `playwright.config.ts`. You will use Playwright to interactively test the CLI TUI (terminal testing).
2. **Follow Test-Driven Development (TDD)**: 
   - Write failing Playwright e2e tests for a specific v2 feature (e.g., streaming a chat, or launching an orchestration workflow).
   - Implement the actual `Service`/`Broker` integrations to pass the test.
   - Wire the React component view model to the new robust event stream.
3. Progressively remove dependencies on `MockBroker.ts` as real streams from the native SQLite Db (`smithers.db`) and LLM API providers are connected.
4. Ensure interactions behave smoothly utilizing the OpenTUI library and ensure complex terminal edge cases (like layout resizing) maintain stable states.

Good luck!
