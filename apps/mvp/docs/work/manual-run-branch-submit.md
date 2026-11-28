---
title: Submit a repository flow after editing its branch
status: done
area: app
owner: codex-astra
updated: 2026-11-27
links: [../features/actions.md]
---

The first Run click after a branch edit triggered a blur schema read that removed the submit button.

A headless Chromium click reproduced the failure with the original blur callback and reached Run with the fix. Editing the branch invalidates older reads and inputs. The existing RunsStore and @smthrs/ui form keep the pending read visible, present any new inputs for approval and send an inputless flow once.
