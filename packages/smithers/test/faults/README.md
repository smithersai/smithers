# CLI fault matrix (#3459)

Run it with `pnpm exec smthrs test '//packages/smithers:faults' --jobs 1`, or
every package's matrix with `pnpm exec smthrs test '//packages/...:faults'
--jobs 1`. `Smithers.FaultSuite` discovers the TypeScript cases under this
directory and runs them serially from `vitest.faults.config.ts`, without
coverage: they spawn real hosts and child processes, kill or suspend them, and
use real SQLite files, sockets, ports and process groups.

| Directory      | What the cases kill or break                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`            | The CLI host: durable recovery, detached parks, reconnects, gateway RPC, subscriber memory, approval scope, process containment and retained jobs |
| `engine/`      | The engine mid-action and while it waits on an approval, an event or a timer; concurrent resume and sweep; the kill crossing (case39)             |
| `sandbox/`     | The sandbox while its engine stays alive                                                                                                          |
| `time-travel/` | The inspector, frame scrubbing and rewind                                                                                                         |
| `harness/`     | Shared drivers: the served host, WebSocket drops and resident-memory sampling                                                                     |

`../FaultTiers.test.ts` fails when a case file is not selected by
`vitest.faults.config.ts` or not keyed by the `faults` target.

The Go-backed durability cases (C-DUR-01 to C-DUR-04), the long tier
(`faultsLong`), the reference-host matrix (`faultsReference`) and their
PostgreSQL and native-program builds were removed with the Go backend on
2026-10-21; `jj file show -r 78407fce59dd <path>` reads them from history.

Engine crash cases own every child they spawn. Handshake and exit waits have
finite deadlines; teardown reaps the hosts and their contained process groups
before removing fixture directories, even after readiness or assertion failures.
The deliberate crash remains separate from this idempotent cleanup.

The subscriber memory case checks each reader's complete set of injected
`control.signal.admitted` command identities and advancing journal cursors
before sampling. Subscriptions stay attached through those samples. Launch
events, duplicate signals, and a replay missing any injected signal cannot
satisfy that boundary.
