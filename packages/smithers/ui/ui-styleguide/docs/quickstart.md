---
title: "Quickstart"
description: "Embed the Paper sheet and select light or dark."
---

```ts
import { standaloneThemeCss } from "@smthrs/ui-styleguide"
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Report</title><style>${standaloneThemeCss()}</style></head>
<body><main><h1>Report</h1></main></body></html>`
```

Paper follows the system preference. Set `data-theme="light"` or `data-theme="dark"`
on the root for an explicit override. No palette picker is required.
For a flow UI use `workflowUiStyles`; for shared React widgets use `SmithersUiStyles`.

[Embed a stylesheet](./guides/embed-a-stylesheet.md) explains composition.
[API](./api.md) documents every runtime export and type.

To request the registered palette explicitly:

```ts
import { themeCss } from "@smthrs/ui-styleguide"
const css = themeCss({ palettes: ["paper"] })
```

The registry contains Paper in light and dark variants. Unknown palette keys throw.
