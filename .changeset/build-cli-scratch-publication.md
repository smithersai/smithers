---
"@smthrs/build-cli": patch
---

Prepare sealed result-cache and installed dependency mounts before executing scratch-tree targets. Publish overlay outputs and cache successes after portal validation. Revalidate submodule checkouts before returning a cache hit. Bind dependency mounts during planning and preserve dirty submodule checkouts when rejecting stale plans. Schedule candidate checks after the candidate is written, including checks composed through aliases and suites. Keep rejected one-shot tool tokens in the refused command instead of crashing while inspecting an empty argv.
