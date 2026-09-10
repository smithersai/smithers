# text/

Tiny text helpers shared across prompts, PR bodies, and rendering.

- `fenceFor.ts` — picks a code fence longer than any backtick run in untrusted
  content, so embedded diffs/snippets cannot break out of their fence
  (prompt-injection and markdown-escape defense).
- `pluralize.ts` — `count + noun`; defaults to an `s` suffix, with an optional
  irregular-plural override.
- `isTestPath.ts` — whether a path names a test file, by directory (`test/`,
  `tests/`, `__tests__/`, `e2e/`, `spec/`) or by filename (`.test.`, `.spec.`,
  `.e2e.`, `_test.`, `_spec.`); the one rule the review checklist, the quiz
  impact score, and the walkthrough chapters share.
- `trimDiff.ts` — per-file diff cap and truncation marker for every agent
  prompt; the limit defaults to 20,000 characters (verifier, quiz), the
  per-file reviewer passes 60,000, and the narrator passes its per-file share.

These are the canonical copies; import from here rather than duplicating them
in feature directories.
