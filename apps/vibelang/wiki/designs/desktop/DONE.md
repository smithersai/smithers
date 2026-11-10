# DONE

- Designed the Electrobun desktop app (VL-6): only what differs from the web app — native titlebar, local-model picker, folder chip, model manager pane, offline and model-error states.
- `index.html` is self-contained (live CSS inlined, dark only) with a top bar switching 7 screens (`#screen`).
- Local work shows in the chat as the agent's ordinary tool calls (`fs.search`/`fs.edit`), an inline diff, and a changed-files list; no invented surfaces.
- Rendered and checked every screen at 1280×800 and the main ones at 390×844 (`desktop.png`, `phone.png`, `*-pick/models/folder/offline/error/loading.png`); no horizontal page scroll.
- `NOTES.md` documents interactions, keyboard paths, reused vs new components, all copy, and each choice's why.
