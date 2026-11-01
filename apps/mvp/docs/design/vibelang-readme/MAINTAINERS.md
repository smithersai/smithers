# Maintaining VibeLang

Draft operating policy. The repository owner must confirm ownership, security intake, and release approval before publication.

## Who maintains what

No VibeLang ownership file was verified. Do not infer maintainership from an author's last commit.

| Area | Review needed |
| --- | --- |
| Language and compiler | Language owner and compiler reviewer, both to be named |
| Runtime and Effect compatibility | Runtime owner, to be named |
| Editors and build integrations | Tooling owner, to be named |
| Guides, specification, and examples | Documentation owner, to be named |
| npm packages and releases | Human release owner, to be named |
| Security reports | Private intake and responsible person, to be confirmed |

The repository owner assigns these responsibilities. Add public handles and backup coverage when each person agrees.

## Triage

Reproduce first. Record the version, platform, smallest input, actual output, and expected behavior. Separate a compiler crash, incorrect emitted program, incorrect diagnostic, and documentation problem. Treat install failures and incorrect execution as release blockers until assessed by the release owner.

The public repository currently has these useful labels:

| Label | Use |
| --- | --- |
| `bug` | Reproduced incorrect behavior |
| `enhancement` | Proposed behavior or capability |
| `documentation` | Guide, reference, or example work |
| `question` | Clarification needed |
| `good first issue` | Bounded task with a clear expected result and test path |
| `help wanted` | Maintainers welcome a contribution |
| `in-progress` | Someone is actively working on it |
| `duplicate`, `invalid`, `wontfix` | Close with a reason and a relevant link |

These labels exist on the current public repository, whose content differs from the local language source. Confirm the release destination before moving or relabeling work. Do not create a release schedule or response-time promise without someone responsible for it.

## Review and merge

One TODO becomes one focused PR. Require a reproducer or behavioral test, relevant checks, and updated docs. Syntax, emitted declarations, runtime semantics, and diagnostics need explicit compatibility review. Keep generated artifacts traceable to their source and toolchain.

A person approves and merges. Agents never approve or merge. Prefer a squash merge for a single TODO. Do not rewrite published history or overwrite a published package version. Confirm protected-branch settings and required checks in the destination repository; this draft does not assert that they are configured.

## Release process

1. Confirm the source revision and destination repository. Resolve stale package homepages and links. Align compiler, platform, runtime, integration, and starter versions. Review the changelog and breaking changes.
2. Run setup, the local starter E2E, compiler cases, affected package tests, editor checks, and documentation snippet checks. Retain commands, toolchain versions, and results. Do not count a skipped platform as tested.
3. Build platform binaries with `scripts/release/build-binaries.sh`, then assemble packages with `scripts/release/make-packages.mjs`. Read the scripts' current options before execution. Check the package manifest, bundled VSIX, license files, notices, dependency versions, and package contents.
4. Use `scripts/release/rehearse.sh` to exercise the tarballs through a throwaway registry with npm and Bun. Its host-only execution cannot prove all six platform binaries work. Obtain native installation evidence for each platform claimed as supported.
5. Have the human release owner inspect the artifacts and authorize publication. `scripts/release/publish.sh` supports a dry run and publishes platform packages before their consumers. It skips an already-published version; inspect partial releases before resuming. Keep credentials out of terminal recordings and reports.
6. Verify the actual registry version using `scripts/release/verify-published.sh` with the released version. Check a clean starter install, execution, tests, and editor installation. Publish release notes with exact versions, breaking changes, known limitations, and links to validation evidence.

Never describe a cross-compiled binary as tested on that operating system. If a release is broken, warn users and publish a new version through the same checks. Keep the broken version's history and explain the fix.

## Security reports

A private VibeLang security-report channel was not verified. Before launch, the owner must enable private vulnerability reporting or publish a monitored security contact in `SECURITY.md`. Link it here after testing intake. Do not direct reporters to a guessed email address or claim GitHub's private reporting is enabled.

Do not request exploit details in public issues. If a public report contains sensitive material, use the hosting platform's moderation process and arrange private follow-up through the confirmed channel. Have a person coordinate remediation, disclosure, and any affected release.

## Benchmark claims

Publish no performance or agent-success claim without a publicly accessible method, pinned versions, task and model definitions, measurement units, sample sizes, results, and limitations. Keep held-out tasks, hidden tests, transcripts, credentials, and private artifacts private. A link to a private benchmark repository is not reproducible public evidence.
