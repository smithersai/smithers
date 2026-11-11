---
title: "Subscription seats"
description: "Select a subscription login with an account-pinned seat."
---

Use `<seat>@<account>` to select a local subscription login:
`claude-code:opus@claude-9`, `opus@claude-2`, `sol@codex-3`, or
`openai:gpt-6.1-sol@codex-default`.

`SMITHERS_ACCOUNTS_DIR` defaults to `~/.smithers/accounts`. Claude accounts
select `CLAUDE_CONFIG_DIR`; Codex accounts select `CODEX_HOME` with
`SMITHERS_OPENAI_AUTH=chatgpt`. `codex-default` uses `~/.codex`.
Pinned seats bypass ambient API keys, pools, and proxies. Unknown accounts,
missing logins, and incompatible seats fail with `SeatUnresolved` naming the
account. The declared seat ID remains unchanged in the journal.

A Codex account is signed in when its directory holds the `auth.json` that
`codex login` writes. Smithers reads that file each time a seat resolves and
each time it signs a request, and never writes it: the Codex CLI refreshes its
own login when Smithers asks. An API-key login cannot serve a seat.

Claude login status is cached for 30 seconds. After signing in or out of
Claude Code, retry seat resolution once that cache expires. Execution still
reports authentication failures from the selected account.

## Role seats

A flow may declare a role seat, such as `coding/review`, instead of a model.
Pin each role the flow declares in `SMITHERS_SEATS`, a JSON object from role
id to a seat alias or an explicit `provider:model`:

```bash
SMITHERS_SEATS='{"coding/review":"sol","coding/implement":"opus"}' \
  smthrs flow start review --data '{"repo":".","commit":"@-"}'
```

The pin resolves like any declared seat, so an alias still runs on Claude Code
when no Anthropic key is set. The journaled seat keeps the role id. A role
seat with no pin fails with `SeatUnresolved` naming `SMITHERS_SEATS`; a value
that is not a JSON object of valid role ids and seats refuses every seat.
