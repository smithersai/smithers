# Agent test farm

These are the versioned sources for `~/.smithers-lead/scratchpad-mirror/`.
Install atomically with:

```sh
node .smithers/flows/land/farm/install.mjs
```

Private `farm-config.json` beside the installed clients contains `miniHost`
(an SSH alias) and `latEndpoints` (lane names mapped to SSH destinations). The
installer preserves it and every live reservation. No deployment address or
credential belongs in this directory. `MINI_RUN_HOST` and `LAT_RUN_ENDPOINTS`
can supply the same settings explicitly. The Mac needs Node, Python, SSH and
rsync; tests additionally need jj, Bash, diff3 and ShellCheck. No install runs
on the Mac. Each client uploads its server helper only after reserving a slot.

```sh
MINI_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/mini-run apps/mvp -- pnpm exec vitest run --coverage.enabled=false db/Database.test.ts
LAT_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/lat-run apps/mvp -- pnpm exec vitest run --coverage.enabled=false db/Database.test.ts
```

Run targeted tests while iterating. The clients pass the actual command's exit
code. They do not turn a failed test into a successful receipt. Coverage remains
an explicit full-suite gate, with its thresholds unchanged.

Admission defaults to 120 seconds, execution to 2400 seconds; use
`MINI_RUN_WAIT_SECONDS` / `LAT_RUN_WAIT_SECONDS` and
`MINI_RUN_TIMEOUT_SECONDS` / `LAT_RUN_TIMEOUT_SECONDS` for an intentional larger
budget. Timeout exits identify capacity, transfer, services or execution. A
stale/ownerless/live reservation is reported, never stolen. Independent SSH
connections avoid a shared multiplex socket wedging all clients. The mini uses
four slots, one e2e reservation and two Vitest workers per command. Latitude
retains host app permits and four workers per command.

Disk admission requires at least 20 GiB free and at most 95% use, before sync or
installation. An unhealthy host is refused; no global cleanup runs. A host
operator must identify disk ownership and capacity. Do not run Podman resets,
prune shared stores or kill unknown processes to make a test pass.

Latitude uses a stable, mode-0700 XDG runtime and a separate farm Podman graph
and runroot. Tests keep their temporary directory. Each run labels its own
containers and removes only those containers and its own database volume on
exit. This avoids reusing namespaces whose temporary runtime was already
removed. Namespace entry is checked immediately, before health polling. Old
running clients and their containers are untouched. Detached launches are
refused because they cannot keep the reservation after the client goes away;
attached runs hold it through real completion and cleanup.

Both hosts stop only process groups recorded by their invocation and remove its
temporary directory on exit. The mini checks old process groups before reuse
and retains a reservation if cleanup is incomplete. Automatic artifact downloads
are off to protect Mac disk. `MINI_RUN_ARTIFACTS=1` requests test results/media;
otherwise the output says which remote slot keeps artifacts until reuse.
Source workspaces and dependencies remain separate from these bounded remote
slots. No automatic cache pruning runs on the Mac.

Checks:

```sh
node --test .smithers/flows/land/farm/farm.test.mjs
shellcheck -S warning .smithers/flows/land/farm/{mini-run,mini-remote.sh,lat-remote.sh,lat-services.sh,health.sh}
```


The tiny remote protocol regression can run independently of occupied app slots:
set `DEVX_MINI_TEST_HOST` to your private SSH alias and run
`node --test .smithers/flows/land/farm/mini-live.test.mjs`. It creates a zero-dependency
fixture under its own temporary mirror, checks real execution/failure/cancellation,
and deletes only that fixture. Full app suites continue to use the reserved clients.
