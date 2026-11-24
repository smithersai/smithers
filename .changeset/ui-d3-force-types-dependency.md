---
"@smthrs/ui": patch
---

Consumers that type-check `@smthrs/ui` no longer fail with TS7016 on `d3-force`. The package ships its `src/`, whose `KnowledgeGraph` imports `d3-force`'s types, so `@types/d3-force` moves from `devDependencies` to `dependencies`.
