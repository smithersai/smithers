---
title: Normalize and audit imported draft statuses
status: done
area: issues
owner: Codex GPT-6.1 Sol
updated: 2026-11-04
links:
  - ../../ops/issues/import.mjs
---

Only open drafts are eligible for import. Count every normalized status, retain skipped keys and duplicate references privately, and refuse unknown statuses before writing plans. Test first on cfbox via nyc-01; leave one unpushed commit.

The existing ops importer normalizes all draft statuses before filtering. Legacy `state` is read only when `status` is absent; absence of both means open. Only open drafts enter deduplication and scrubbing. The printed and saved summary counts all drafts before filtering, with `planned` equal to the open count. Non-open rows retain their keys, normalized statuses and duplicate references in the mode-600 `<out>.skipped.jsonl`. Unknown values refuse the import with exit 2 and name the key and value before any output is written.

Validation: the test-first run failed 20 tests (88 passed); the implementation passed all 108 ops/issues tests across six files. Both runs used cfbox via nyc-01 with only jj-tracked files staged; staging trees were removed immediately. No libraries or filing-time behavior changed. Review script, landing and push omitted as requested.
