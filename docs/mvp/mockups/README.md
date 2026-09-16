# MVP design prototypes

The standalone HTML files open directly in a browser. They contain simulated repository data and local interactions. They do not call production APIs, create issues, run agents, or constitute release test evidence. Scenario controls outside the depicted product replace the conversation host's prototype controls.

The first four sources were copied from the reviewed fragments under .artifacts/mvp-issues-design-20260916. The tracked copies adopt the release owner's draft-first reply default and preserve stale evaluation/trial evidence. The original conversation artifacts remain unchanged.

- [Starting actions and five setups](start.html)
- [Issue setup and trial scenarios](issues-setup.html)
- [Issue work, POC, fix, and decomposition](issue-work.html)
- [Evals and prompt/expectation editing](evals.html)

The exported documents are self-contained and work offline. The export removes optional remote tooltip/icon scripts from the generic renderer; the prototypes use native controls and their own styles. Its small scenario bridge only exchanges local presentation messages between the document and its sandboxed frame.

Editable prototype sources are under sources/. Export them with the installed visualization renderer:

```sh
python3 docs/mvp/mockups/export.py --renderer /path/to/visualize/skills/visualize/scripts/render.py
```

The original export used:

```text
/Users/williamcory/.codex/plugins/cache/openai-bundled/visualize/1.0.32/skills/visualize/scripts/render.py
```

Generate the PNG design figures using the repository's installed Playwright dependency:

```sh
node docs/mvp/mockups/capture.mjs
```

The capture script drives simulated controls and renders figures for DESIGN.md. It also records page errors, external requests, image dimensions, and overflow measurements at 320px in capture-results.json. These checks apply only to these local prototype documents. They do not verify the application, backend, real eval quality, accessibility as a whole, or a deployed release.
