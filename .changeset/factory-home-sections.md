---
"@smthrs/targets": minor
---

`Smithers.Factory.Home` now also takes `{ sections, docs?, contributors? }`, the audience-gated `.smithers/home.json` shape `@smthrs/views` already reads, so `FactoryProjection` can write a home with maintainer- and contributor-only sections and a docs index. The `{ blocks }` form renders byte for byte as before.
