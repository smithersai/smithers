# 0108: First load waits for nothing it doesn't show

2026-10-25. Implements ARCH-5 ("local first no loading spinners other than waiting for external agents") for a cold,
signed-out visit, the one a launch visitor from VibeLang makes to `smithers.sh/smithersai/vibelang`.

## What we measured

A cold signed-out visit to smithers.sh first painted at 7.9 to 9.5 s, on `/` and on `/smithersai/vibelang` alike
(production 9c0c4e4a53, three runs each). The page's main thread was idle for most of it. The time went to:

```
0.0-0.8  HTML, the 1.17 MB (brotli) main bundle, its parse          the page
0.9-1.6  the 2.96 MB engine worker downloads and leads               the engine worker
1.6-2.0  wa-sqlite, the OPFS pool, the session read, the owner check
2.0-3.1  435 flow registrations each sweep due timers; device/prepare
3.2-8.1  the app's layers wait on the device store: about 680 SQLite
         transactions from 45 persisted collections, each paying
         ~4 ms of rollback-journal I/O, and the flow editors' restore
8.1-8.6  render, then the repository's own data (0.3 s)
```

Thread traces showed the engine worker busy 85 to 95% from 3.5 s to 9.5 s, 80% of it inside wa-sqlite's
access-handle VFS writing, reading and deleting the rollback journal. The Electric gateway's queue (b79eddb7) was not
the bottleneck: fixing it moved first paint by under 0.5 s.

## Decisions

1. **The browser's SQLite journals in a write-ahead log.** `@smthrs/platform-browser`'s `BrowserSqlite.open` sets
   `locking_mode = EXCLUSIVE`, `journal_mode = WAL` and `synchronous = FULL` on the access-handle pool's databases
   (`engine.db` and `app.db`). WAL needs shared memory or an exclusive lock; the pool has one owner and one connection
   per file, so exclusive costs nothing. `FULL` keeps the durability the Node and Bun hosts have. A cold app start's
   transactions cost a third of what they did, and `NORMAL` would buy only another 0.2 s.
   *Hard to reverse:* a database converted to WAL can't be opened by a build without this change. A rollback to such a
   build leaves those devices running on memory, data intact, until a build with WAL serves them again.
2. **No layer the page renders with waits on device storage.** The flow editors (`flow-form`, `flow-answers`,
   `flow-code`) restore and seed in the background: their state is `restoring`, then `available` or `unavailable`,
   their cards show nothing until then, and an edit waits for it. Before, every page waited for them, up to 5 s.
3. **The boot records its stages.** `page`, `worker`, `activation`, `store`, `services` and `render` are
   `performance` marks (`smithers.boot.<stage>`), one `boot.stages` log and a `smithers_web_boot_stage_ms` point per
   stage (src/bootStages.ts). Only names and times.
4. **A budget, checked live.** `pnpm bench:first-load` (bench/first-load.ts) visits `/` and `/smithersai/vibelang`
   cold, five times each, and fails when either's median first contentful paint exceeds 4.5 s or its median first
   meaningful content (its heading) exceeds 5.0 s, on a built server ([benchmarks](../benchmarks.md#first-load)).

## Results

`pnpm bench:first-load`, five cold signed-out visits per route, medians:

```
                                  FCP /      content /   FCP vibelang   content vibelang
smithers.sh, 9c0c4e4a53           8,284 ms   8,262 ms    8,724 ms       8,669 ms
236dfbe849, served locally        7,064 ms   7,043 ms    7,372 ms       7,339 ms
this decision, served locally     2,080 ms   2,058 ms    3,084 ms       3,051 ms
```

"Served locally" is a production build whose assets come from the measuring machine and whose `/api/*` goes to
smithers.sh: the same database, Electric gateway and session reads, without the CDN's 0.3 to 0.6 s for the bundle.
236dfbe849 is main of that morning, whose boot is the same as 9c0c4e4a53's. The receipts are in
[bench/first-load-results](../../bench/first-load-results/).
The page now renders 60 ms after the device store opens (`store` 1,974 ms, `render` 2,037 ms). What remains is the
engine worker's chain: its download, OPFS and the session read until `activation` (949 ms), then 435 flow
registrations and `device/prepare` until `store`.

## Not yet

The page still renders only once the device store opens (`Persistence.layer` sits under every store). Rendering the
route before it, from memory and the network, is the next step toward ARCH-5's instant page, and needs a design for
collections that adopt persistence after they exist. Smaller next steps, each measured above: start the engine
worker's session read before OPFS opens (0.2 to 1.5 s, the session read's own latency); sweep due timers once, not once
per registration (0.7 s); start persisted collections when something reads them, not at construction (22 shapes become
13, among them 4.7 MB of another repository's issues); and precache only the shell, not 500 files and 25 MB, after
first paint.
