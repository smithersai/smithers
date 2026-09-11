# Flow traces

`Commands.ts` records each invocation as a `flow.invoked` transition before
`AppStore` persists it. `/debug.verbose` also renders and logs that record.
Redaction applies with verbose enabled or disabled.

- `env.set` traces retain the variable name and optional repository, with the
  assignment value replaced by `[REDACTED]`. Malformed assignments are masked.
- `form.set` traces retain the card and field identifiers and mask the value.
  Form schemas currently have no sensitivity declaration, so all field values
  are masked without guessing from names or token patterns.
- Nonempty detail text from `env.set`, `form.set`, and `form.submit` is masked.
  Handlers can echo input in errors, and form submission can echo assembled
  arguments in success text.

Execution receives the original arguments. This policy covers flow diagnostic
records; it does not alter environment configuration or persisted form drafts.
It applies to new traces and does not rewrite existing stored transitions.

Regression coverage: `flows/Commands.test.ts` and `state/Verbose.test.ts`.
