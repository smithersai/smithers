---
title: Target secret proxy transport integrity
status: done
area: targets
owner: cr-s-5043 code-review lane
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5043]
---

Preserve binary uploads, representation lengths on `HEAD` and `304` responses,
and capability URLs when a protected pathname overlaps replacement text.

The existing target proxy owns this boundary; no public API or platform
boundary changes are needed. Regression tests exercise real HTTP upstreams
through the proxy, secret destinations and brokered origins.
