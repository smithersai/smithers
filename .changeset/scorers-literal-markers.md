---
"@smthrs/scorers": minor
---

Treat all strings in `Checks.includes`, `Checks.excludes` and `Checks.leakage`
as literal text, preserving their word-boundary and text-normalization rules.
Pass `RegExp` values for intentional patterns; `/source/flags` strings and
trailing-`*` stems no longer opt into pattern matching.

Before, `Checks.leakage([{ sink: "log", text: "secret-123" }], ["/secret-\\d+/"])`
failed. Now it passes because the string is literal. Use `[/secret-\d+/]` to
keep the former pattern behavior. Regex objects keep their flags and caller-owned
`lastIndex`. Literal paths no longer throw, and regex-shaped secret markers
cannot silently pass leakage checks.

Recognize required URLs wrapped in backticks, bold, underscores or braces, and
preserve balanced parentheses in Markdown link targets.
