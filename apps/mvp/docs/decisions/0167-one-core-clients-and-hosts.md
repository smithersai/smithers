# 0167 — One core, clients and hosts

Date: 2026-11-16. Status: accepted (Will's words in chat; rulings CORE-1 to CORE-12).

## Context

By 2026-11-16 the repository held several applications built quickly to try
features: `apps/mvp`, `apps/vibelang`, `apps/tui` and others. A draft
specification for the Vibe factory reviewed those applications screen by
screen. Will rejected it the same day: "we lost the plot". He asked for a pure
product specification, because "what we are actually about to do is build the
final version of smithers ui app", and then stated the architecture that the
final product stands on.

## Decision

Smithers is one core that works with no user interface. Every other part is a
client of that core.

```
 clients     command line · MCP · web interface · TUI · script
                 │ one API
 core        every product rule, state and action
                 │ Effect dependency injection
 platform    files (jj or git) · database (SQLite, Postgres) · the rest
```

1. The core works with no interface; an interface is one type of client
   (CORE-1).
2. The core is a true core, the command line has feature parity with the
   interface, and the interface is a thin wrapper (CORE-4, CORE-12).
3. The core is modular through Effect dependency injection and runs on all
   platforms; the Cloudflare deployment is one expression of it (CORE-5,
   CORE-6).
4. Everything is a tree of clients and hosts. A client is a file system and a
   database. A client that spins up a sandbox or a VM becomes that new client's
   host. Smithers cloud is the top host unless someone self-hosts (CORE-7,
   CORE-8).
5. Most functionality lives in Smithers. A factory such as Vibe is an
   expression of configuring a Smithers app, in web standards (CORE-9).
6. Smithers builds Smithers, and the minimum product has the final product's
   shape and starts headless (CORE-2, CORE-3).

[The architecture page](../../../../docs/architecture/core-clients-hosts.md)
explains each point with a diagram.

## What this replaces

| Before | Now |
| --- | --- |
| Rulings section 19 (2026-11-07): `apps/vibelang` is its own Foldkit app, with its wiki as its source of truth. | `apps/vibelang` is a proof of concept and reference code. The Vibe factory is a configuration of Smithers (CORE-9, CORE-10). |
| SCOPE-5 (2026-10-19): the work is the feature list, "not an MVP scope". | We decide a minimum product, and it starts headless (CORE-3). The feature list still describes the product. |
| ARCH-8 and FE-5: the application's logic stays out of React, in an Effect state machine inside the app. | The logic belongs in the core, reachable from the TypeScript API and the command line (CORE-4, CORE-12). |

## What this does not change

- SCOPE-8 and HOST-1: what ships first is hosted on Cloudflare. CORE-5 and
  CORE-6 rule how the core is built, so that the same code runs elsewhere.
- DUR-1 to DUR-7: everything is a durable flow.
- PLUGIN-1: everything is a plugin. CORE-9 states the same idea for a whole
  factory.
- BR-7: people merge, agents never.

## Consequences

- A change that puts product logic in a view, or in a server that belongs to
  one app, is wrong by construction.
- A capability lands in the core first, then gets a command-line verb, then a
  screen.
- No core package may import a platform directly, and no behavior may exist
  only in the Cloudflare deployment.
- A factory is not shipped as an application.
- Three audits started on 2026-11-16 measure the code on `main` against these
  rules: logic held only by the command line, logic held only by an app, and
  the platform, composition and host-tree rules. Until they report, treat
  conformance as unknown.

## Open

Section 18 of [the rulings](../rulings.md) lists what Will has not ruled:
whether `apps/mvp` is also reference code, what the minimum product contains,
how clients sync and whether a client works cut off from its host, how clients
talk to each other, and which web standards a factory uses.
