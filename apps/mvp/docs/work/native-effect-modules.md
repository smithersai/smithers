# Native infrastructure modules

The infrastructure resources that preserve their existing contracts use VibeLang `0.0.13`. Tests, configuration, templates, plain throwing code and host adapters remain TypeScript.

The app's source readers are part of its contract. The registry, configuration, data-gate and session lifetime checks inspect TypeScript bodies. Their inputs retain those bodies; declarations do not replace them. Captured flows also retain TypeScript when native emission changes a frozen resume identity. Plain Node dependency chains and bundler inputs keep the formats their callers support.

Plain bundlers reach native dependencies through the repository's `#vibelang/emitted` import routes. Nested infrastructure projects emit adjacent `.d.vibe.ts` declarations, and their exact `types` routes name those files. Every app compiler project uses `rewriteRelativeImportExtensions` so a later project cannot replace emitted imports with source extensions. The migration flow routes imports and emits their owners again before recording loader inputs.
