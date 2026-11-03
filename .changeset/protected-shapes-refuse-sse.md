---
"@smthrs/effect-electric": patch
---

Refuse SSE on no-store shapes with 400 before calling Electric. Both live_sse
and experimental_live_sse must be absent or explicitly false. A protected
shape's one access check cannot authorize an unbounded stream after removal;
long polling checks access on each new request. Explicitly public shapes can
still use SSE.
