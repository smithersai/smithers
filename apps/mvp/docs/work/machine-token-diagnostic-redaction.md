---
title: Machine and scoped token diagnostic redaction
status: review
area: sdk
owner: codex-smmredact
updated: 2026-11-04
links: []
---

Use the catalogued @smthrs/journal Redaction and @smthrs/engine-store durable
run services. Add regressions before changing the rules. Tests use invented
credentials only, run in cfbox, and compare failure names with main 7bc198f5.
No landing or push is authorized.

Issuer audit: apps/mvp/ops/machine-token/issue.ts emits smm_ plus 32 random
bytes encoded as 43 base64url characters. packages/smithers/control/src/ScopedToken.ts
emits smt1.<base64url JSON claims>.<43-character base64url HMAC-SHA256>.
Neither prefix has a textual rule. Existing rules cover the GitHub OAuth,
installation and fine-grained tokens, provider sk-/pk- keys, JWTs, GitLab,
npm, Google, Slack and AWS AKIA credentials handled by the repository.
Unprefixed session, runner and bearer values still require sensitive fields,
headers or credential assignments; their random bytes have no unique prefix.

Before the fix, cfbox recorded 24 failing journal/diagnostic cases and two
failing stored-terminal-failure cases. Prefix rules now redact complete machine
and scoped wire forms, including URLs and underscore wrappers. Typed executable
errors stay unchanged on replay. Full comparisons and exact-change review
receipts are retained in the lane's operations record.

Astra found that provider-key redaction could consume a valid token's interior
before the Smithers rule ran. Smithers rules now precede those rules; exact-output
regressions cover both token formats and their stored failures with an interior
provider-key shape.

The follow-up review found an overlapping machine prefix inside a scoped
signature followed by underscore text. Scoped tokens are matched first so
their claims and entire signature disappear together; both redactors and
stored failure replay have exact-output regressions for this overlap.

Enclosing-credential regressions then exposed the reverse interaction: a
Smithers-shaped substring could fragment an existing API key, GitHub PAT,
GitLab token or JWT before its rule ran. All 12 new direct/stored cases failed
before correction in cfbox. Smithers rules now redact the containing dotted
identifier, preserving sentence punctuation and protecting both directions
of overlap in one linear scan. Executable typed errors remain unchanged.

Contextual regressions exposed bearer/query suffixes and sensitive assignment
names that token rewriting could obscure. Fourteen direct cases and six stored
failure cases failed first. The selected built-in contextual rules now read the
original text before token rewriting. Custom policies and contextual-name aliases
have public-API regressions; no custom rule is silently replaced or added.

Basic-header and preceding-custom-rule regressions failed first (three direct,
one stored). Contextual protection now runs at each Smithers rule's actual
position, preserving earlier custom processing. Basic's partial base64 matcher
is excluded from lookahead. An opaque custom rule interposed before later
contextual rules closes the whole value rather than being crossed; this has
a public-policy regression.

PEM rewriting can overlap an issued token's valid base64url suffix. Four direct
and two stored regressions failed first, using a canonical 32-byte base64url
fixture. A selected built-in PEM or Smithers rule now closes a value containing
both credential forms. Custom replacement policies and a mere BEGIN mention
have separate regressions.

Contextual rewriting could itself split a scoped signature between an assignment
value and a subsequent credential name. Eight direct and two stored regressions
cover this and customized PEM replacements alongside the default token rules.
Contextual changes now replace the whole message; unchanged text still uses word
redaction. Custom PEM markers cannot fragment a token protected by a selected
Smithers rule, while PEM-only policies retain their requested behavior.

Streaming continuation checks now inspect the original text with the multiline
rules alone: prefix tokens cannot cross newlines. Conservative whole-value
masking is applied only when rendering, so complete credential lines and closed
PEM blocks release without hiding later ordinary progress. Regression cases
also keep unfinished quoted credentials held until they close.

Two provider-overlap stream regressions and a structured failed-attempt restart
regression for each prefix cover the next review findings. Stream openness also
checks contexts with destructive built-in prefix rewrites omitted, retaining
custom rule order. Typed Fail values now bypass message/stack redaction in the
inert attempt projection; defect diagnostics retain that redaction. A literal
message/stack error schema survives interruption after attempt settlement,
replays without dispatch, and leaves a separately redacted terminal diagnostic.
The old test that required mutation of typed error fields now requires fidelity.

Bearer rewriting can also erase the name of an unfinished assignment or flag.
Independent continuation probes now inspect each selected contextual grammar on
the original text, retaining selected custom-rule order and the earlier hold
conditions. Four regressions cover both prefixes with assignments and flags;
a separate case preserves preceding custom stream-rule behavior.

Paired custom stream-policy cases cover both prefixes before and after Smithers
recognition. A matching rule's opaque custom barrier now also governs continuation
analysis; a following custom rewrite cannot certify closure by erasing an opener
that rendering masks earlier. Such streams stay withheld under existing bounds.
Preceding custom rewrites still run before that decision.

Continuation analysis carries recognition from each selected Smithers rule's
ordered position after preceding custom rewrites. Both-prefix decoding cases
hold their unfinished credential, release safely at closure and preserve later
progress; the extra probes no longer require a prefix in the original text.

Rendering now exposes an internal protection observer at the actual rule position
on every bounded fixed-point pass. Streaming probes use those snapshots rather
than reimplementing recognition. Four regressions cover multiple decoding passes
and completed-block-only custom PEM rewrites for both prefixes. Active PEM overlap
always probes the canonical PEM grammar, while a PEM-only policy stays independent.
