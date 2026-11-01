# Handoff notes

Drafted 2026-10-20. Only this output directory was written. No commits, pushes, source edits, publishing, or Git CLI calls.

## Source and destination

Read the local README, package manifests, starter, editor guide, compiler Go module, setup/build/E2E scripts, and release scripts under `~/effectscript`. Inspected its docs, examples, packages, templates, and editor layout. Local language package versions are 0.0.2.

Used `gh repo view smithersai/vibelang` and `gh api` to inspect the public repository metadata, recursive tree, package manifest, README endpoint, labels, and community profile. The README endpoint resolves to `docs/README.md`, a Vocs documentation-site README. The public root package describes an earlier 0.0.1 design, and the public tree does not match the current local language layout. These drafts target the local language source, not a claim that its files already exist on public main. Confirm the repository migration before publishing relative links.

The local root LICENSE explicitly says MIT except the TypeScript fork and compiler packages, which retain Apache 2.0 and upstream notices. The public repository metadata reports MIT. The README preserves the local split; do not flatten the compiler license to MIT.

## Benchmark boundary

Read only repository metadata, top-level filenames, and the benchmark README's overview. It explicitly says the repository is private and hidden tests and held-out splits must stay there. No hidden tests, held-out tasks, transcripts, or result artifacts were read. No explicitly public method/results summary was established, so no benchmark numbers or performance claims appear in the drafts. Obtain an approved public method and results page before adding any claim. No private benchmark content is reproduced here.

## Unverified claims and open decisions

- Confirm the release destination and that the linked language docs, examples, editor guide, specification, and license files will exist there.
- Confirm the named maintainer roster, public handles, backup coverage, release approver, merge policy, and required branch checks. MAINTAINERS marks the roster and operating policy as drafts; the PR and squash policy is proposed guidance, not verified repository configuration.
- No root VibeLang code of conduct was found. CONTRIBUTING links the real upstream compiler policy with its limited scope. Adopt a project-wide policy and monitored conduct contact before final publication.
- No security intake was verified. Confirm private vulnerability reporting or a monitored address and add SECURITY.md. No email or working private-report link was invented.
- No separate chat, forum, or Discord was verified. Help links use the public issue tracker. Existing labels were checked, but no claim is made that open good-first-issue tasks exist.
- Node 26 / Bun 1.4 guidance comes from the source README; published package engine declarations permit Node >=22. The lowest supported versions were not tested. Go's compiler module requires 1.27; setup began with Go 1.26 and downloaded 1.27.
- Editor capabilities and marketplace status are source-documentation claims, not independently tested here. No GUI extension installation or Neovim/Zed test was run.
- No six-platform compatibility claim is made. No release, registry publication, native cross-platform test, docs deployment, or benchmark was run.
- The feature explanation is supported by source docs and the executed README examples. Full language semantics and TypeScript declaration interoperability were not exhaustively tested.
- No guessed shell command appears in README or CONTRIBUTING. Commands come from real scripts or were executed. Proposed human policies are clearly distinguished above.

## Validation

All executions use `validation/` beneath this directory, with temporary paths and npm/Bun/Go caches redirected there. The source copy excludes dependency/build output, VCS metadata, and large baseline/testdata directories. It is sufficient for the setup and package checks attempted here; it is not a pristine full compiler-suite checkout. Dependency installation may resolve newer external versions. See logs for actual outcomes.

- `bun create vibelang@latest my-app`: passed against the public registry, with an empty local starter directory. It installed the starter and dependencies.
- `cd my-app`: executed successfully.
- `bun run start`: passed for the original starter, with both README output lines.
- `bun run test`: passed, one file and two tests.
- Ten-line README example: compiled and ran with its exact two output lines. Initial draft used `new EmptyName({})`; compiler rejected it. Corrected to `new EmptyName()` and reran successfully. Keep `validation/example-1.log` as the failed-draft receipt and `example-1-fixed.log` as final evidence.
- Service/concurrency README example: compiled and ran, printing `Ada Guest`.
- `cd packages/compiler` and `node --test test/*.test.mjs`: passed 15, skipped 5, failed 0. The skipped checks mean this is not complete compiler integration coverage.
- Setup and contributor E2E outcomes are recorded below after completion.

README code blocks contain a ten-line opening example and no em-dash asides. No image assets or unannounced product attribution were added.

- `sh scripts/setup.sh`: executed in the source copy; stopped during native Go compilation after several minutes. It downloaded Go 1.27 and dependencies but did not reach runtime/editor setup. Not a passing check.
- `sh scripts/e2e.sh`: executed in the source copy; stopped at the same setup/native-build stage. No local E2E pass is claimed. The published starter checks above are separate evidence.
- Both unfinished Go build process trees were stopped before handoff. Logs are retained.
- Relative Markdown link targets were checked against the drafts and local language source; none were missing. Public destination availability remains a release question.
