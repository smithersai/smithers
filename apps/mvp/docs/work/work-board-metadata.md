---
title: Work board metadata validation
status: done
area: process
owner: Codex
updated: 2026-11-13
links:
  - ../../../../apps/maintainer-site/README.md
  - ../../../../apps/maintainer-site/test/work-metadata.test.mjs
---

Completed reports use `status: done`, and source and regression links resolve
relative to their note. The run change-feed report has delimited frontmatter
with its title, area, owner and update date.

The maintainer site's `--check` mode validates notes without writing the site.
Its regression suite checks the corrected reports, every board status, missing
or malformed frontmatter, and valid and broken metadata and Markdown links.
