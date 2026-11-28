---
title: All-project home dashboard
status: done
area: app
owner: codex
updated: 2026-11-27
links: []
---

Will wants one signed-in home dashboard for every project. Show the person's project roster, actionable work and links into each project's Workbench and Runs. Keep home chat available. Verify the signed-in production view against the actual project roster.

The admission contract is documented in [Projects on Home](../features/projects-dashboard.md) and [decision 0177](../decisions/0177-personal-project-roster.md). Production build `2090c777fef8` passed all five deployment smoke checks. The signed-in dashboard preserved all 13 saved projects through reload, with a Workbench and Runs link for each. The signed-out check confirmed the private roster and summaries both return 401.
