---
"@smthrs/cli": patch
---

Control journal projection refreshes membership each pass, then pages only runs whose committed journal head or rewind generation moved. Late records and children on completed runs remain visible; adapters without bulk reads retain per-run reads.
