# Render Markdown documents

Use Markdown with variant="document" for repository content. Complete leading
YAML metadata is hidden; continuation lines stay inside list items. Tables
scroll independently on narrow screens.

Document blockquotes and inline HTML formatting nest up to `16` levels. Deeper
blockquotes show their remaining source as plain paragraph text; deeper HTML
tags are dropped while retaining their text. Omitted paragraph and list-item
end tags do not hide subsequent headings. A deeply nested comment or README
therefore stays readable without overflowing the render stack.

Fences use the repository-home tokenizer for TypeScript, JavaScript, VibeLang
and shell. Unsupported languages stay plain. A supplied CodeBlock highlighter
still takes precedence. highlightCode(source, language) exposes the same lines
of CodeToken values: text plus an optional CodeTokenKind. Joining the tokens
with their line breaks reproduces the source.

markdownDocumentBody(source) removes only a complete leading metadata block.
Chat mode retains its source and line-break behavior.

Repository file previews use @smthrs/repo-view's MarkdownEditor. Its read-only
HTML policy preserves supported formatting and drops comments, scripts, styles,
event attributes and unsafe URLs. It does not change editable Markdown source.
