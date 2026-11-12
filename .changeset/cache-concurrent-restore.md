---
"@smthrs/build-cli": patch
"@smthrs/build": patch
---

A remote cache restore no longer fetches one blob at a time, and concurrent target restores no longer queue behind each
other. A cache handle runs its CAS exchanges through one shared, adaptive bound: it starts at the two transfers both
cache services admit, halves after a `429`, and grows by one after a long run of admitted exchanges, up to eight. An
entry's files, chunk indexes, and chunks are fetched concurrently, targets that share bytes fetch each digest once, and
local verification, chunking, and assembly share a fixed bound of eight, so memory stays bounded. Every chunk and whole
file is still verified before it enters the CAS, and the first missing artifact still makes the entry a miss.
