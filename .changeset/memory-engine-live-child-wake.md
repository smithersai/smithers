---
"@smthrs/engine": patch
---

Deliver a wake that lands on a live child after that round parks, without
re-driving a root ahead of its polling follower. This preserves recorded race
replay and prevents a live child from losing its completion.
