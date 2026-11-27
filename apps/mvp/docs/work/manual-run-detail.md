---
title: Open a hosted run directly
status: done
area: runs
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

Use the engine inspection and the public `@smthrs/sandbox` CI result schemas to show the job and its commands on the run page. The `@smthrs/ui` run header distinguishes a skipped job from a stopped run. Navigation reports loading and descendant inspection outcomes.

The existing hosted run's read-only inspection contained four levels, down to a failed checkout with a null exit code and a skipped command. Local React replay showed those outcomes through a direct repository URL. A fresh production reload displayed the details after its inspections arrived. The earlier generic route fallback did not recur on the stable deployment.
