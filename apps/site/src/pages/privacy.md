---
layout: ../layouts/Legal.astro
title: Privacy Policy
description: What Smithers collects, why, and who processes it.
updated: September 25, 2026
---

<!-- COUNSEL REVIEW PENDING: draft by Tevm Inc., 2026-09-25. Not reviewed by a lawyer. -->

**Tevm Inc.**, a Delaware corporation doing business as **Smithers**, runs smithers.sh and Smithers Cloud. This policy says what we collect, why, and who else handles it. We do not sell personal information.

## What we collect

| Data | Source | Why |
| --- | --- | --- |
| GitHub or email identity: username, name, email, avatar | You, when you sign in | Your account |
| Repositories you connect | GitHub, with the access you grant | Running the work you ask for |
| Prompts, chat messages, run logs and agent output | You and the Service | Running and showing your work |
| Billing details: plan, invoices, the last four digits of your card | Stripe | Payment. We never see full card numbers |
| Usage: model calls, credit used, sandbox time | The Service | Metering, limits and billing |
| Technical logs: IP address, browser, errors | Your browser and our servers | Security and debugging |

## How your code is handled

When you run work on a repository, Smithers clones it into an isolated sandbox virtual machine on Google Cloud. Agents read and change the code there. The parts of your code and prompts that a task needs are sent to a model provider to produce the result. Changes reach your repository only when you or the workflow you started pushes them.

## Subprocessors

| Company | What they do for us |
| --- | --- |
| Anthropic | Runs AI models on prompts and code |
| OpenAI | Runs AI models on prompts and code |
| Stripe | Payments and subscriptions |
| Google Cloud (GCP) | Hosting, databases and sandboxes |
| Cloudflare | Website, edge network and request routing |
| GitHub | Sign-in and access to the repositories you connect |

Under their API terms, Anthropic and OpenAI do not train models on API data by default.

## Retention and deletion

We keep your data while your account is open. Email [support@smithers.sh](mailto:support@smithers.sh) to get a copy of your data or to delete your account. We delete account data within 30 days of a deletion request, except records we must keep by law, such as payment and tax records. A sandbox keeps its copy of your code while its workspace exists, including while it sleeps; deleting the workspace or your account deletes it.

## Your rights

Depending on where you live, you may have the right to access, correct, delete or export your personal information, and to object to some processing. Email us to use any of these rights. We will not treat you differently for using them.

## Security

We use encryption in transit, isolated sandboxes, scoped access tokens and access controls. No system is perfectly secure; report security issues through [GitHub private vulnerability reporting](https://github.com/smithersai/smithers/security/advisories/new).

## Children

The Service is not for anyone under 18.

## Changes

We will post changes here and email you about material ones.

## Contact

Tevm Inc. (d/b/a Smithers) · [support@smithers.sh](mailto:support@smithers.sh)
