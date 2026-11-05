# Diffs

Diff-to-HTML helpers retained by the review flow. Pierre renders highlighted line-numbered changes; asset extraction shares its styles across the walkthrough. The fallback renderer handles binary, oversized or failed diffs and preserves line anchors for findings.

The pinned offline Pierre resource loads on the first textual diff. Its Shiki
subset covers TypeScript/TSX, JavaScript/JSX, JSON/JSONC, CSS, HTML, Markdown,
YAML, TOML, shell, SQL, Go, Rust, Python, C/C++, C#, Java, Dockerfile, patches,
XML, Vue and Svelte. Other languages retain readable Pierre line numbers,
word diffs and annotations using plain text. Only Pierre's light/dark themes
are included. No network or installed package is required at rendering time.

Regenerate after a dependency update with
`node .smithers/flows/review/src/diffs/generate-pierre-runtime.mjs`; add `--check`
to verify freshness. The resource is generated from the real Pierre/Shiki APIs,
with the dependency catalogs narrowed during bundling. The compressed bytes
remain part of the measured flow closure, including dependency license notices.
The runtime executes only these pinned bytes, never patch text as JavaScript.

`renderer-size.test.ts` enforces a 2.5 MiB single-file renderer budget, no external
package imports, one Mermaid resource per walkthrough, and offline Chromium
rendering for flowcharts, sequence diagrams, state diagrams and highlighted diffs.
Library catalog: the existing review flow renders its self-contained artifact
through Pierre SSR; the app continues to display it through the shared HTML
result renderer. This changes dependency packaging, not the UI component model.
