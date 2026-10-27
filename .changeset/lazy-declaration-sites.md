---
"@smthrs/flow": patch
---

A declaration's source position is captured as a stack and formatted only when something reads it. Formatting every stack as a flow or action was declared cost a browser worker about 120 ms while it loaded its flows, and a page about 25 ms, for sites a browser can never name. What a site reads is unchanged.
