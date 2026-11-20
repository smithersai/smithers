# Resume an archived release candidate

Start a new `workflow_dispatch` of the existing **Release** workflow with the same `releaseTag` as the original candidate. Supply both `candidateRunId` (the completed Release run) and `candidateArtifactId` (its immutable `release-candidate-<run-id>` artifact ID). Leave `dryRun` enabled to verify the resume without publishing. Re-running the original run does not supply these new inputs and reuses its artifact name, so the workflow refuses any attempt after the first before its first gate; use a new dispatch for an archive resume. Empty archive inputs keep the normal new-candidate build, pack, and smoke path.

The original run may have failed during publication. Its candidate artifact was uploaded only after the source gates and installed-consumer smoke completed. The resume runs the current source gates again, then restores the original artifact instead of rebuilding or replacing its smoke receipt. The selected run must belong to this repository's Release workflow; fork/PR runs, expired or differently named artifacts, mismatched IDs, and missing integrity are refused.

The downloader selects the immutable artifact ID, caps the download at 512 MiB before writing excess bytes, verifies its SHA-256 archive digest, and extracts only unique flat regular files into a fresh temporary directory. Extraction is bounded by the expected source package count plus five fixed evidence files and 1 GiB of expanded bytes. It then verifies the requested tag's commit, the complete dependency-ordered package roster and versions, lockfile hash, original successful smoke receipt, every tarball's SHA-512 integrity, and any versions already on the registry. Only a fully verified candidate becomes the publish directory. Publication independently runs its preflight again and skips existing versions only when their integrity is identical.

The workflow-run source SHA can differ from the candidate's SHA when a workflow dispatch checks out a separate `releaseTag`. The restoration receipt records both. The candidate manifest and checked-out git tag establish the candidate's source identity; run/artifact metadata establish which workflow produced its archive.

`restore-evidence.json` records the original run/artifact IDs, archive digest, workflow source, candidate source, and packages still missing from the registry. The resumed workflow also archives the verified directory under its own run ID. Each retry can therefore use an immutable archive without repacking.

Publication uploads every tarball under the `staging` dist-tag, leaving `next` and `latest` unchanged. `staging` is a word, not a semver range, so npm accepts it as a tag. After every package passes its integrity read and `npm view <name>@<version> version`, publication reads `next` for a suffixed version or `latest` for an unsuffixed version and moves it only when the current version is not newer by semver. A missing tag can be created; an unreadable or invalid current version fails publication. Resuming an older candidate preserves a newer consumer tag. The local release flow applies the same comparison. These tag writes follow the tested dependency-ordered roster, with `smthrs` last. Version reads retry with bounded backoff for registry propagation. The publish job supplies `NODE_AUTH_TOKEN` from `NPM_TOKEN`, the same credential used by `npm-dist-tag.yml`; promotion uses `npm dist-tag add` with that token and does not require OIDC dist-tag support or new trusted-publisher permissions.

Publication rewrites `publish-receipt.json` after every package it publishes or promotes, and the run uploads that file as `release-publish-receipt-<run-id>` after the publish step, on failure as well. A train that stopped halfway therefore leaves a record of which names landed, next to the registry preflight the resume runs anyway. `promoted` lists successful consumer-tag writes in this attempt. A resume verifies all existing package bytes and versions again, skips identical tarballs, and repeats the idempotent tag writes, including after a partial promotion, unless a newer version now holds the tag. The registry remains the authority; the receipt records progress. `awaiting` lists names whose upload npm accepted and has not served yet; a name whose upload failed is never in it. npm serves a version minutes after it accepts the upload (82 to 498 s on the v1.0.0-rc.18 run), so publication reads each version once after its upload, uploads the next without waiting, then re-reads every awaiting name for up to 30 minutes after the last upload. Different bytes still stop it at once.

All publishing jobs in the Release workflow share the `npm-publication` concurrency group across release tags, with in-progress cancellation disabled. This keeps each consumer-tag read and write inside one publishing job. Gates, dry runs and source rehearsals use separate groups. GitHub retains only one pending job per group, so dispatch a release again if a later dispatch cancels it while pending.

A missing or expired archive is a failed resume, not permission to rebuild different bytes under an already published version. For a changed candidate, use a new version and repeat the complete release validation. Publication remains controlled by the workflow's existing `dryRun` input and npm-publish environment.

The local restore implementation uses Node, the GitHub CLI, and Python 3's standard ZIP library, available on the workflow's Ubuntu runner. All GitHub calls are read-only and request JSON metadata under API version `2026-03-10`; archive bytes are downloaded by artifact ID. The action token needs `actions: read`. The endpoint and metadata contract is documented by GitHub's [artifact API](https://docs.github.com/en/rest/actions/artifacts) and [workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs).

## A package name that is new to npm

Trusted publishing cannot create a package name: npm configures it per existing package. The `NPM_TOKEN` token creates names in the scope it was granted and in no other, so an unscoped name, or a name in another scope, needs the npm account owner once. On the v1.0.0-rc.18 tag run (44620940500) the token created `@smthrs/fuzz`, `@smthrs/platform-cloudflare` and `@smthrs/views`. The unscoped `smithers-ci` answered 403 after 49 immutable uploads, leaving `smthrs` unpublished and no consumer tag moved.

Before its first upload, publication therefore reads whether npm knows the name of each package whose version the registry lacks (`npm view <name> name`; 404 means the name is new, and any other answer fails the run). A new name passes when npm already serves another package of the candidate in its scope (`@smthrs` today), or when the `allowNewNames` input lists it; the run prints each name it admits. Any other new name stops publication with an error that names every such name. The same check runs on the paths that publish nothing:

- A dry run of a new candidate: "Compute the publish plan" runs `publish-release.mjs --check-names` on the packed candidate and reads every name. The local rehearsal driver runs that step too.
- A restore of an archived candidate, dry run or not: it runs the publication preflight.
- The local release flow: candidate verification runs the publication preflight before the approval prompt. It has no `allowNewNames` input.

`allowNewNames` is a Release `workflow_dispatch` input, passed to the scripts as `RELEASE_ALLOW_NEW_NAMES`: exact package names of the candidate, comma separated. Set it only after the token can create those names, for example once its grant covers a new scope.

To publish a candidate with a new name the token cannot create, the npm account owner:

1. Downloads the candidate archive the resume will restore and publishes each new name once from its tarball, with npm 11:

   ```sh
   npm publish smithers-ci-1.0.0-rc.18.tgz --access public --tag staging --provenance=false
   ```

   The tarball must be the candidate's own bytes: the resume compares the registry's `dist.integrity` with the candidate's and refuses other bytes under that version. A tag run stops before its first upload and has already archived its candidate, so its `release-candidate-<run-id>` archive is the one to use; a dry run of the tag works the same way. A `sourceRef` rehearsal's candidate cannot be restored, so its report is notice only. npm 11 lets these flags override the tarball's `publishConfig` (`tag: next`, `provenance: true`); provenance needs the workflow's OIDC identity, which a hand publication lacks.
2. Gives the release credentials the name: adds the package to the `NPM_TOKEN` token's packages and configures its trusted publisher as for the existing packages. The resume moves the package's consumer tags with that token.
3. Resumes the candidate as the start of this page describes. Its preflight finds the hand-published version with identical integrity and skips it, publishes the versions still missing, then moves the consumer tags in roster order, `smthrs` last.

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
