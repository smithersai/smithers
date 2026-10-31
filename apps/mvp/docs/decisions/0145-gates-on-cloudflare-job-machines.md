# 0145: Gates run as repository flows on Cloudflare job machines

Status: accepted
Date: 2026-10-30. Applies FLOW-14, FLOW-8, GH-1, M-47, ARCH-13, ARCH-14 and ARCH-16.

Will asked whether Cloudflare sandboxes can be Smithers' merge queue (FLOW-14).
A prototype ran the whole apps/mvp suite in 16 Cloudflare containers in 312 s
for about $0.16, against 713 s on the Mac mini, with 6 failures and these gaps:
no fan-in, one image and one instance type per deployment, no root setup, no
internet, no merged coverage, a tree baked into the image, and about 10 minutes
of image preparation per new image. This record decides how a gate runs.

## Decision

A gate is a repository flow: `.smithers/flows/gate/flow.ts`, planned in the
QuickJS realm and run by `repo/Run` on the repository-flow spine
([CI on Smithers](../features/ci.md)). Each job is a `ci/job` on its own job
machine. A merge-queue check is that flow's run, and its result is the commit
status `smithers/gate` (GH-1, GH-10).

```
FlowExecution DO (Postgres via Hyperdrive)
 repo/Run { repo, sha, flow: "gate" }
   repo/Plan ── flow.ts at the sha ─▶ QuickJS realm ─▶ 17 jobs (data)
   repo/Jobs ── ci/graph { target, jobs }                       SandboxObject DO + container
                  wave 1: mvp-1 … mvp-16 at once ── ci/job ─────▶ machine "gate": image + standard-4
                          checkout sha; pnpm install --offline;    fixtures as processes on tmpfs
                          vitest --shard=i/16 --reporter=blob      PUT blob ─▶ artifacts (R2, run scope)
                  wave 2: mvp-coverage (needs mvp-1 … mvp-16) ──▶ GET 16 blobs; vitest --merge-reports
             ── repo/Report ─▶ smithers/gate success | failure (App, Commit statuses)
```

### What each gap became

| Gap | Decision |
| --- | --- |
| (a) Engine without Postgres | Not built. Every deployment that runs gates already has Postgres: production's Neon through Hyperdrive, and the proof stage's own Neon project. Gates run on the `FlowExecution` engine like every repository flow. |
| (b) Fan-out and fan-in | `repo/Jobs` already starts every job at once (`Node.all`). Jobs gain `needs`; `@smthrs/sandbox`'s `ci/graph` runs them in waves and skips a job whose need didn't pass. `worker/flows/Checks.ts` (the `.smithers/checks/*.sh` scripts, one after another) is not the gate path and is unchanged. |
| (c) Image and instance per job | A job names a machine (`machine: "gate"`). The deployment declares its machines: each is a container class with its own image and instance type. A repository can't name an image, an instance type or a machine the deployment didn't declare; an unknown name fails the job before its checkout. |
| (d) Root setup | The image's entrypoint does it, as root, before the box idles: `/tmp` becomes a tmpfs, so Postgres' fsyncs and the suite's `TMPDIR` never touch the btrfs disk. Steps never get root. |
| (e) Network | A gate box reaches the package registries and nothing else, as every job box does. Tests don't need the internet: the two that did (`RepoAbout.workerd`, `TestDatabase`) take a local double of the outside service they don't test. No egress allowlist grows for tests. |
| (f) Coverage | Each shard writes a vitest blob report, with its coverage, to the run's artifacts. The coverage job downloads all 16 and runs `vitest --merge-reports`, which applies the 100% thresholds to the whole suite. |
| (g) Per-commit checkout | The existing `ci/job` checkout: the one commit by its id through the box's forge proxy (Code Storage when the deployment has an organization, else the public GitHub repository), detached. |
| (h) Image preparation | The gate image carries `node_modules` installed from one lockfile and is tagged by that lockfile's digest. A checkout with the same lockfile installs offline in seconds. A changed lockfile installs through the registry egress from the image's warm store, then a rebuilt image (built and pushed from nyc-02) is deployed. No Latitude fallback. |

### Artifacts

A job box writes and reads its run's artifacts at `http://artifacts.smithers.internal/<name>` with `PUT` and `GET`. The box's
Durable Object answers that host itself, as it answers the forge proxy's: it stores the body in an R2 bucket under the
digest of the run the machine belongs to, and reads only from there. A box can't name another run, and no credential
enters it. Objects are capped in size and expire after 7 days. An artifact is data: no step runs it unless the
repository's own step does, inside its own box.

### Trust boundaries

- **System flows can't be overridden.** `repo/Run`, `repo/Jobs`, `ci/graph`, `ci/job` and the report are the
  deployment's code. The repository supplies data only: job names, steps, `needs` and machine names, checked against
  schemas outside the realm (M-47).
- **Secrets stay opaque.** A gate gets no secrets, and its box no placeholders. Artifacts and logs carry no secret
  (ARCH-16, OBS-5).
- **Agents never approve or merge.** A gate writes one commit status and moves no ref. Whatever lands a change reads
  `smithers/gate` and decides; for customer repositories that is a person (TODO-1, BR-7).
- **A gate runs exactly the commit.** The checkout must be the run's sha before any step runs.

### Smithers' own merge queue

A candidate is pushed to `gate/<name>` on GitHub. The trigger
`{ "on": "github.push", "flow": "gate", "branches": ["gate/**"] }` in `.smithers/factory.json` starts the gate at
that commit, and `smithers/gate` lands on it. The lander moves `main` to a commit only when its `smithers/gate` is
`success`. Until that is turned on, landers keep running the suite on Latitude.

## Proof

On the non-production stage `smithers-gates-<name>`, deployed only through the vault wrapper, with its own Neon
project and R2 bucket and no GitHub App, Code Storage organization or custom domain: the gate's jobs, planned by the
realm from the commit's `flow.ts`, run on Cloudflare at a commit of `main` checked out per job. Done when the apps/mvp
gate has 16 shards, 0 failures and merged coverage at 100% in under 400 s, twice in a row. The stage has no GitHub App,
so it writes no status; its door that starts a run is test code, never deployed to production. Spend stays under $20,
and the stage is destroyed when idle.

## Turning it on in production

1. Build and push the gate image for `main`'s lockfile from nyc-02, and set the deployment's gate image to its digest.
2. Deploy: the `gate` machine's container class and the artifacts bucket.
3. Add `smithersai/smithers` to `REPO_FLOWS_REPOSITORIES`, and the `gate/**` trigger to `.smithers/factory.json`.
4. Point the lander at `smithers/gate` instead of the Latitude suite.

## Rejected

- **A SQLite engine in a Durable Object for gates.** It would be a second engine host for a deployment that already
  has Postgres.
- **Cloudflare's Sandbox SDK.** Branch sandboxes don't use it; the gate uses the same `SandboxObject` seams.
- **Root for steps.** Root setup is the image's; a repository's step can't widen it.
- **Internet for tests.** A gate's verdict would depend on GitHub's anonymous rate limit from Cloudflare's shared
  addresses, and a box with the internet is a box that can leak.
- **Falling back to Latitude when the lockfile changes.** The warm store makes the changed install a network delta.
