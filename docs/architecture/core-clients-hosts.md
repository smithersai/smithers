---
lifecycle: evergreen
owner: Will
depends_on:
  - apps/mvp/docs/rulings.md
  - apps/mvp/docs/decisions/0167-one-core-clients-and-hosts.md
  - apps/mvp/docs/decisions/0168-every-client-is-local-first.md
verified: 2026-11-16
---

# One core, many clients, a tree of hosts

Smithers is one core that works with no user interface. Everything a person or
an agent touches is a client of that core. The core runs on every platform, and
every running copy of it is a local-first node in a tree of clients and hosts.

Will set this architecture on 2026-11-16 and called it vital: "It's extremely
important we are architected like this truly", and "if we mess this up we might
mess everything up". His words are recorded as rulings CORE-1 to CORE-18 in
[the rulings](../../apps/mvp/docs/rulings.md), section 20. This page explains
them. Where this page and a ruling disagree, the ruling wins and this page is
the bug.

These are requirements, not a description of the code. Three audits of `main`
at commit `ae8286fe` on 2026-11-16 found that the durable engine conforms and
most of the rest does not: the only complete local host is assembled inside the
command-line package, the issue-to-merge loop lives only in `apps/mvp`, the
Cloudflare deployment runs a second control plane beside the core's, no code
models a tree of hosts, and the sync route on `smthrs serve` refuses every
read. Treat every section below as the target.

## The eight rules

| # | Rule | Ruling |
| --- | --- | --- |
| 1 | The core works with no user interface. A user interface is one type of client. | CORE-1 |
| 2 | The core is a true core: it holds the product's functionality. The interface is a thin wrapper around it. | CORE-4 |
| 3 | The command line has feature parity with the interface. | CORE-4 |
| 4 | The core is extremely modular through Effect dependency injection, and it runs on all platforms. | CORE-5 |
| 5 | The deployed Cloudflare infrastructure is one expression of the core, which runs anywhere. | CORE-6 |
| 6 | Everything is a tree of clients and hosts. Each client can itself be a host. | CORE-7, CORE-8 |
| 7 | Every client is local-first. It writes to its own files and database, and sync is a background concern that is never programmed per feature. | CORE-13 to CORE-16 |
| 8 | Most functionality lives in Smithers. A factory such as Vibe is an expression of configuring a Smithers app, written with web standards. | CORE-9 |

Two rules set the order of work:

- Smithers is used to build Smithers (CORE-2).
- The minimum product has the shape of the final product and starts headless
  (CORE-3). Everything built before 2026-11-16, `apps/vibelang` included, is a
  proof of concept and reference code (CORE-10).

## 1. One core, many clients

```
   people and agents
          │
 ┌────────┴────────────────────────────────────────────────────┐
 │ clients     command line   MCP   web interface   TUI   script │
 │             they ask and they draw; they hold no product logic │
 └────────┬────────────────────────────────────────────────────┘
          │ one API, the same for every client
 ┌────────▼────────────────────────────────────────────────────┐
 │ core        every product rule, every state, every action     │
 │             complete with no client attached                  │
 └────────┬────────────────────────────────────────────────────┘
          │ services the core asks for, supplied by dependency injection
 ┌────────▼────────────────────────────────────────────────────┐
 │ platform    files (jj or git)      database (SQLite, Postgres) │
 │             processes   network   secrets   clock              │
 └─────────────────────────────────────────────────────────────┘
```

The core is the product. Remove every client and it still accepts work, runs
it, checks it and records it. A client adds a way to ask and a way to look.

A capability therefore enters the product in one order:

```
 core API  ──▶  command-line verb  ──▶  interface screen
 exists first    exposes it              exposes it

 the command line and the interface expose the same capabilities; neither adds one
```

What this rules out:

- Product logic in a view, or in a server that belongs to one app (CORE-12).
- An interface feature with no command-line verb (CORE-4).
- A command-line feature that a TypeScript caller cannot reach (CORE-12).

## 2. One core, many expressions

The core never names its platform. It asks for services, and each platform
supplies its own implementation through Effect dependency injection.

```
                              the same core
        ┌──────────────┬───────────────────┬──────────────────┬──────────────┐
        │ a laptop     │ Smithers cloud    │ a self-hosted    │ a sandbox    │
        │              │ (Cloudflare)      │ server           │ or VM        │
 ───────┼──────────────┼───────────────────┼──────────────────┼──────────────┤
 files  │ jj or git    │ jj or git         │ jj or git        │ jj or git    │
 data   │ SQLite       │ Postgres          │ SQLite, Postgres │ SQLite       │
 ───────┴──────────────┴───────────────────┴──────────────────┴──────────────┘
        each column is the core plus the services that platform supplies
```

Cloudflare is one column of this table. It gets no private path through the
product, and nothing the product does may work only there.

The columns are examples, not a closed list. The rule is "all platforms"
(CORE-5), the browser included.

What this rules out:

- A core package that imports a platform directly.
- Behavior that exists only in the Cloudflare deployment.
- A second implementation of a core service inside an app.

## 3. What a client is

Will's picture of a client (CORE-8): "a file system (jj/git) and a sqlite
database and/or postgres database and these things sync and have clients".

```
 one client
 ┌───────────────────────────────────────────────┐
 │ files      a jj or git repository              │
 │ database   SQLite and/or Postgres              │
 │ core       the same code on every client       │
 └───────┬─────────────────────────┬─────────────┘
         │ syncs with              │ spins up sandboxes and VMs
         ▼                         ▼
     its host                  new clients, with this client as their host
```

"Client" here means a running copy of Smithers, not only a screen. Smithers
cloud is one such client. A laptop is another. A sandbox is another.

### The inside of a client

A client is built the way an Ethereum client is built (CORE-18): five layers
with fixed jobs. Will named each layer and its analogue.

```
 Ethereum client                     Smithers client
 ─────────────────────────────────────────────────────────────────────────────
 JSON-RPC, over HTTP, WebSocket      external API, one method set served over
 or a local socket                   any transport that is plugged in
 ─────────────────────────────────────────────────────────────────────────────
 consensus                           sync: local-first, CRDT based
 ─────────────────────────────────────────────────────────────────────────────
 execution (the EVM)                 execution: the durable execution engine
 ─────────────────────────────────────────────────────────────────────────────
 database and state                  storage: the file system (jj or git) and
                                     the database (SQLite or Postgres)
 ─────────────────────────────────────────────────────────────────────────────
 common: shared primitives           common: the platform and everything else
 and configuration                   that is dependency injected
```

The analogy breaks in one place on purpose. Ethereum consensus makes every node
agree on one order before anything counts. A local-first client accepts its own
writes at once and merges with others later.

The interfaces between these layers are not designed yet. A design was started
on 2026-11-16 for Will to review; until he accepts one, this section states the
shape and nothing more.

## 4. Every client is local-first

A client follows all the rules of local-first (CORE-13). It reads and writes
its own files and its own database, and it keeps working when its host is out
of reach.

```
 a feature's code                       the sync engine, in the background
 ┌──────────────────────────┐          ┌───────────────────────────────────┐
 │ write a file              │          │ carries changes to the host        │
 │ write a row               │   ───▶   │ brings other clients' changes back │
 │ read either               │          │ handles conflicts                  │
 │                           │          │ catches up after time offline      │
 │ never mentions sync       │          │                                    │
 └──────────────────────────┘          └───────────────────────────────────┘
          this client's files and database are always the thing it reads and writes
```

The rule for feature code is strict: it writes to the file system and to SQLite
or Postgres, and that is all (CORE-14). A feature that contains its own sync,
retry-to-server or conflict code is built wrong. Will calls making this "just
work" a major engineering concern.

Local-first also gives the product multiplayer: two clients of one host see
each other's changes, routed through that host (CORE-13).

```
 client A ──▶ host ──▶ client B          a change made on A reaches B through their host
 client A ◀── host ◀── client B          and the other way
```

One limit comes from the architecture, not from a rule: a client that runs its
sandboxes on a host cannot reach those sandboxes while it is disconnected from
that host.

### Private and shared

A record does not have to leave the client that made it (CORE-16). A person can
keep their own issues while working, the same way they keep their own branches.

```
                      stays on this client        also lives on the host
 ──────────────────────────────────────────────────────────────────────────
 files, in jj or git   a private branch            a branch that always syncs
 records, in the       a private issue             a shared issue
 database
 ──────────────────────────────────────────────────────────────────────────
                      nobody else sees it          everyone with access sees it
```

Branches already work this way. The product makes the same choice formal for
records.

## 5. The tree of clients and hosts

```
 Smithers cloud                       the top host
   ├─ a laptop                        client of the cloud, host of its own sandboxes
   │    ├─ sandbox
   │    └─ VM
   ├─ another laptop
   │    └─ sandbox
   └─ a cloud sandbox

 self-hosted: the same tree with your own server at the top

 your server                          the top host
   ├─ a laptop
   │    └─ sandbox
   └─ a sandbox
```

- Some clients have a specific host.
- Each client can itself be a host.
- A client that spins up a sandbox or a VM creates a new client and becomes its
  host.
- Smithers cloud is always the top host, unless someone is self-hosting.
- Clients can talk to other clients.

## 6. Smithers and a factory

```
 ┌──────────────────────────────────────────────────────────────┐
 │ a factory, such as Vibe                                        │
 │ an expression of configuring a Smithers app, in web standards  │
 └───────────────────────────────┬──────────────────────────────┘
                                 │ configures
 ┌───────────────────────────────▼──────────────────────────────┐
 │ Smithers                                                       │
 │ most functionality, built once, for every factory              │
 └──────────────────────────────────────────────────────────────┘
```

A factory is not an application of its own. `apps/vibelang` was a place to try
the app and its features without being slowed by Smithers (CORE-10). The real
Vibe factory is a configuration that Smithers loads.

What this rules out:

- A factory shipped as its own application with its own copy of shared screens.
- A factory format that needs a framework Smithers does not load on every
  platform.

## 7. The order of work

```
 1  core, headless        the TypeScript API and the command line
 2  dogfood               Smithers builds Smithers through that core
 3  interface             a thin client over the same API, with parity
 4  factories             Vibe first, as configuration
```

The minimum product is step 1 in the shape of the final product (CORE-3). It is
not a smaller, different product.

## Open questions

Will has not ruled on these. Each one changes the design, so none is settled by
this page. The positions are the documenting agent's proposals, not rulings.

| Question | Proposal, not ruled |
| --- | --- |
| Which sync engine carries rule 7? It must sync files and SQLite or Postgres rows between any client and its host, in both directions, with conflicts handled and no per-feature code. | Not proposed yet. It is the largest engineering risk on this page: a client that is itself a host may hold SQLite, so an engine that reads only from Postgres cannot serve the whole tree. |
| How is "private" against "shared with the host" made formal? | One scope on every record and every branch: private to this client, or shared with a named host. Sharing a private record is one explicit act, like pushing a branch. |
| May two clients sync directly, with no host between them? | Not proposed yet. Routing through a host is ruled (CORE-13). |
| Which web standards does a factory use? | JSON with a published schema for what it declares, ES modules on `Request` and `Response` for what it runs, Markdown for what it says, custom elements for what it draws, URLs for where things live. |
| Is the existing command line the minimum product? | Only once it carries one change through the whole loop on the Smithers repository with no web page opened. |
| Does "everything before now was just a poc and reference code" include `apps/mvp`? | Not proposed. Ask Will. |
