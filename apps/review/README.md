# smithers review

Agent code review that reads like a story.

`smithers review` runs one review agent per changed file, then a narrator
agent writes a walkthrough of the whole change: chapters in logical reading
order, prose explaining why each group of files changed, diffs embedded at
the right point in the narrative, and Mermaid diagrams wherever structure
changed. The output is a single self-contained HTML file you can open,
share, or publish to a hosted URL.

Pointed at a GitHub pull request, it also posts the review onto the PR: the
narrative summary as the review body, and every finding as an inline comment
with a ` ```suggestion ` block when there is replacement code to apply.

Findings never fail the build. smithers review reports; humans decide.

## Add it to your repo

One workflow file. No secrets, no Anthropic account, no smithers checkout.
The service authenticates your repo through GitHub OIDC, runs the agents on
our metered inference, posts the review, and hosts the walkthrough.

1. **Register your repo.** v0 accounts are operator-issued while billing is
   built out (early repos are subsidized). Open an issue titled
   `review access: <org>/<repo>` on
   [smithersai/smithers](https://github.com/smithersai/smithers/issues) or
   contact the maintainers.

2. **Add `.github/workflows/smithers-review.yml`:**

```yaml
name: smithers review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  id-token: write       # proves your repo's identity to the review service
  contents: read        # check out the PR
  pull-requests: write  # post the review

concurrency:
  group: smithers-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: smithersai/smithers/apps/review/action@main
```

Keep the workflow on `pull_request`. Never switch it to
`pull_request_target`: the review agents execute the PR's code, and
`pull_request_target` would hand that code elevated credentials.

3. **Trigger a review.** Comment on any PR:

```
@smithers review
```

Only owners, members, and collaborators can trigger reviews. Repos
registered in `auto` mode skip the comment and review every non-draft PR
push; `comment` mode is the default. The mode is a server-side setting on
your registration, so switching never touches your workflow file.

### Reviewer quiz

High-impact changes get a short comprehension quiz: 3–6 multiple-choice
questions a reviewer can answer only if they actually read and understood
the change. It is honor-system — nothing blocks a merge on the score.

The quiz auto-triggers when the assessed impact is **high** or
**critical** (security-sensitive paths, schema/migration changes, risky
added code, critical findings, sheer size, …); the specific reasons behind
the assessment are listed in the walkthrough. Force it with `--quiz on`,
disable it with `--quiz off` (CLI), or set the `quiz:` action input.
Quiz generation uses a model independently of `--no-review` and `--no-narrate`.
For offline use, pass all three: `--no-review --no-narrate --quiz off`.

After taking the quiz in the walkthrough, copy the attestation (your
score) into a PR comment so the author knows the review was earned.

### Plans and quota

Subscriptions meter reviewed PRs — a monthly per-repo PR allotment set on
your registration; the status comment shows remaining quota.
Re-reviewing a PR that already counted this month is free. When the quota
is spent, the action skips with a notice instead of failing your checks.

### Use your own subscription (optional)

If you own the repo you can pay for its inference directly instead of using the
service's metered inference. Repo registration, quota counting, and walkthrough
hosting work exactly as before; only the inference moves to your key, so your
metered spend on the service stays zero.

Set one of these as a repo secret and pass it through in the job:

```yaml
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: smithersai/smithers/apps/review/action@main
```

`OPENAI_API_KEY` works the same way and moves both seats onto the `openai:`
provider. The action prefers Anthropic when both are set, and it scrubs the raw
secret out of the environment before the review starts: the run reads an
untrusted diff, so it is handed only the credential its chosen mode needs.

0.x offered two subscription modes instead, one per CLI agent: it wrote your
`~/.codex/auth.json` for the Codex CLI, or forwarded `CLAUDE_CODE_OAUTH_TOKEN`
to the Claude Code CLI. This release runs no CLI subprocess — a seat resolves to
a provider route — so the credential is an API key and there is nothing to
materialize on disk. `CODEX_AUTH_JSON` and `CLAUDE_CODE_OAUTH_TOKEN` are
ignored.

## Run it from the terminal

`review` is not a Smithers engine verb. This package ships its own bin,
`smithers-review`, which runs the same flow against any repo on your machine:

```sh
node apps/review/bin/smithers-review.mjs --help
```

```sh
# review the working tree of a repo, write .smithers-review/walkthrough.html
smithers-review /path/to/repo

# review a branch against main, open the walkthrough when done
smithers-review /path/to/repo --from main --to HEAD --open

# review one commit
smithers-review /path/to/repo --commit abc1234

# review GitHub PR #123 and post the review onto it (via gh)
smithers-review /path/to/repo --pr 123

# publish the walkthrough to the share service and print an unlisted URL
smithers-review /path/to/repo --pr 123 --publish

# no seats: deterministic story, no review findings (works offline)
smithers-review /path/to/repo --no-review --no-narrate --quiz off
```

See [review commands](docs/commands.md) for the comment trigger and offline flags.

The repo path defaults to the current directory. Seats are `provider:model`
strings, and the provider ahead of the colon decides which credential is read:

| Variable | What it sets |
| --- | --- |
| `SMITHERS_REVIEW_SEAT` | Reviewing and verifying seat. Default `anthropic:claude-sonnet-4-5`. |
| `SMITHERS_REVIEW_CHEAP_SEAT` | Narrating and quizzing seat. Default `anthropic:claude-haiku-4-5`. |
| `SMITHERS_REVIEW_VERIFY_SEAT` | Overrides the verifying seat alone. |
| `SMITHERS_REVIEW_NARRATE_SEAT` | Overrides the narrating seat alone. |
| `SMITHERS_REVIEW_QUIZ_SEAT` | Overrides the quizzing seat alone. |
| `ANTHROPIC_API_KEY` | Credential for `anthropic:` seats. |
| `OPENAI_API_KEY` | Credential for `openai:` seats. |
| `OPENROUTER_API_KEY` | Credential for `openrouter:` seats. |
| `ANTHROPIC_BASE_URL` | Sends `anthropic:` seats to a proxy origin instead of `api.anthropic.com`. |

`--publish` needs a publish service URL in `SMITHERS_REVIEW_PUBLISH_URL` and an
API key (`srk_…`, operator-issued) in `SMITHERS_REVIEW_PUBLISH_TOKEN`; both can
also be set in `~/.smithers-review.json`.

## The service

The hosted side is a Cloudflare Worker at `https://review.jjhub.tech`:
session minting from GitHub OIDC tokens, an Anthropic-compatible metered
inference proxy, walkthrough hosting on R2, and usage accounting in D1.
Design: [src/server/README.md](src/server/README.md).

Not built yet, tracked as issues: Stripe subscriptions, self-serve signup
and key management, the `review.smithers.sh` domain.

## Contributing

Architecture, the publish service, self-hosted CI setup with your own
credentials, diff rendering exports, and the test suites are documented in
[CONTRIBUTING.md](CONTRIBUTING.md).

See [proxy budget admission](docs/proxy-budget.md) for supported requests,
reservation limits and settlement recovery.
