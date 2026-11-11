# Resume an archived release candidate

Start a new `workflow_dispatch` of the existing **Release** workflow with the same `releaseTag` as the original candidate. Supply both `candidateRunId` (the completed Release run) and `candidateArtifactId` (its immutable `release-candidate-<run-id>` artifact ID). Leave `dryRun` enabled to verify the resume without publishing. Re-running the original run does not supply these new inputs and reuses its artifact name, so the workflow refuses any attempt after the first before its first gate; use a new dispatch for an archive resume. Empty archive inputs keep the normal new-candidate build, pack, and smoke path.

The original run may have failed during publication. Its candidate artifact was uploaded only after the source gates and installed-consumer smoke completed. The resume runs the current source gates again, then restores the original artifact instead of rebuilding or replacing its smoke receipt. The selected run must belong to this repository's Release workflow; fork/PR runs, expired or differently named artifacts, mismatched IDs, and missing integrity are refused.

The downloader selects the immutable artifact ID, caps the download at 512 MiB before writing excess bytes, verifies its SHA-256 archive digest, and extracts only unique flat regular files into a fresh temporary directory. Extraction is bounded by the expected source package count plus five fixed evidence files and 1 GiB of expanded bytes. It then verifies the requested tag's commit, the complete dependency-ordered package roster and versions, lockfile hash, original successful smoke receipt, every tarball's SHA-512 integrity, and any versions already on the registry. Only a fully verified candidate becomes the publish directory. Publication independently runs its preflight again and skips existing versions only when their integrity is identical.

The workflow-run source SHA can differ from the candidate's SHA when a workflow dispatch checks out a separate `releaseTag`. The restoration receipt records both. The candidate manifest and checked-out git tag establish the candidate's source identity; run/artifact metadata establish which workflow produced its archive.

`restore-evidence.json` records the original run/artifact IDs, archive digest, workflow source, candidate source, and packages still missing from the registry. The resumed workflow also archives the verified directory under its own run ID. Each retry can therefore use an immutable archive without repacking.

Publication uploads every tarball under the `staging` dist-tag, leaving `next` and `latest` unchanged. `staging` is a word, not a semver range, so npm accepts it as a tag. After every package passes its integrity read and `npm view <name>@<version> version`, publication reads `next` for a suffixed version or `latest` for an unsuffixed version and moves it only when the current version is not newer by semver. A missing tag can be created; an unreadable or invalid current version fails publication. Resuming an older candidate preserves a newer consumer tag. The local release flow applies the same comparison. These tag writes follow the tested dependency-ordered roster, with `smthrs` last. Version reads retry with bounded backoff for registry propagation. The publish job supplies `NODE_AUTH_TOKEN` from `NPM_TOKEN`, the same credential used by `npm-dist-tag.yml`; promotion uses `npm dist-tag add` with that token and does not require OIDC dist-tag support or new trusted-publisher permissions.

Publication rewrites `publish-receipt.json` after every package it publishes or promotes, and the run uploads that file as `release-publish-receipt-<run-id>` after the publish step, on failure as well. A train that stopped halfway therefore leaves a record of which names landed, next to the registry preflight the resume runs anyway. `promoted` lists successful consumer-tag writes in this attempt. A resume verifies all existing package bytes and versions again, skips identical tarballs, and repeats the idempotent tag writes, including after a partial promotion, unless a newer version now holds the tag. The registry remains the authority; the receipt records progress. `awaiting` lists names the registry accepted but had not served yet. A brand-new name can take minutes to be served, so a version still absent after its own retries no longer stops the train: publication continues, then re-reads every awaiting name for up to 15 minutes. Different bytes still stop it at once.

All publishing jobs in the Release workflow share the `npm-publication` concurrency group across release tags, with in-progress cancellation disabled. This keeps each consumer-tag read and write inside one publishing job. Gates, dry runs and source rehearsals use separate groups. GitHub retains only one pending job per group, so dispatch a release again if a later dispatch cancels it while pending.

A missing or expired archive is a failed resume, not permission to rebuild different bytes under an already published version. For a changed candidate, use a new version and repeat the complete release validation. Publication remains controlled by the workflow's existing `dryRun` input and npm-publish environment.

The local restore implementation uses Node, the GitHub CLI, and Python 3's standard ZIP library, available on the workflow's Ubuntu runner. All GitHub calls are read-only and request JSON metadata under API version `2026-03-10`; archive bytes are downloaded by artifact ID. The action token needs `actions: read`. The endpoint and metadata contract is documented by GitHub's [artifact API](https://docs.github.com/en/rest/actions/artifacts) and [workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs).

## Rehearse an untagged main commit

For a fresh candidate before creating a release tag, dispatch **Release** from `main` with `dryRun=true`, an explicit `sourceRef` containing the full 40- or 64-character commit SHA already pushed to main, and `releaseTag` naming the intended `v<version>`. Leave both archived-candidate IDs empty. For example, after setting `SOURCE_SHA` to the chosen full SHA:

```bash
gh workflow run release.yml --ref main \
  -f releaseTag=v1.0.0-rc.0 \
  -f sourceRef="$SOURCE_SHA" \
  -F dryRun=true
```

This path checks out that exact commit and verifies its ancestry to `origin/main`. It runs every existing version, changelog, source, build, and smoke gate, archives the tested candidate, installs and starts the packed CLI on the four installer platforms, and skips publication. The intended tag need not exist; a stale changelog still fails and must be corrected in a new source commit before certification. The candidate records the checked-out source SHA and intended release label.

### Prereleases

A suffixed version such as `1.0.0-rc.1` is a prerelease. It publishes under the npm `next` dist-tag, and only what proves it builds, installs and starts can block it (`AGENTS.md`, "Doneish first; release continuously"). The publish job therefore runs as two parallel lanes:

| Lane        | Runs                                                                       | A failure                                   |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| `candidate` | Version check, build, pack, installed-consumer smoke, archive, publication | Fails the run and stops publication         |
| `gates`     | Every gate, including the changelog check                                  | Shows red on the run; the run does not fail |

A rehearsal of a prerelease is green when the `candidate` lane, the native helpers and the installer jobs pass. Read the `gates` lane for what is red on that commit; its results are in `release-gate-results-<run-id>-gates`. Installer signing does not run for a suffixed version.

A prerelease never moves `latest`. To point a dist-tag of one `@smthrs/*` package at a version already on npm, dispatch `.github/workflows/npm-dist-tag.yml`. It uses the `NPM_TOKEN` repository secret, refuses unscoped names and versions that are not on npm, and refuses to move a 0.x `latest` unless `replaceZeroLatest` is true:

```sh
gh workflow run npm-dist-tag.yml -f package=@smthrs/flows -f version=1.0.0-rc.8 -f tag=latest
```

An unsuffixed version runs one `release` lane: every gate, then the candidate, then publication. Any red gate blocks it, and a stale changelog blocks it before the build.

New candidates must pass installed-consumer smoke on Node 26.4.0 with npm 11.16.0, using the tarballs they were packed as. The separate `release-smoke-evidence-<run-id>` artifact retains `node26.json`; its upload also runs on failure. The candidate's `smoke-evidence.json` is the Node 26.4.0 receipt. Archived-candidate restores preserve the original receipt.

`sourceRef` is refused for publication and for every archived-candidate restore, including a restored dry run. Those paths still require a real release tag pointing to the exact tested source. An untagged rehearsal does not authorize creating or pushing that tag. The local rehearsal script skips the checkout action, so it does not establish that GitHub checked out the selected SHA.
