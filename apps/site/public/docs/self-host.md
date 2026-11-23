# Self-host Smithers

> Run a single-Mac team install: set up the host, merge stacked TODOs, manage members and secrets, and put HTTPS in front.

This guide sets up one Smithers install on an Apple Silicon Mac for your team: start the host, finish onboarding, merge your first TODO, invite teammates, and harden access with HTTPS and backups.

:::caution[Planned feature]
**Planned.** The Homebrew host package is not released yet; the procedures below apply once it ships. To run coding agents on your Mac today, follow [Run agents on your Mac](https://smithers.sh/docs/local-quickstart/).
:::

```text
TEAM LAPTOPS                       YOUR APPLE SILICON MAC (LaunchAgent)
+----------------------+           +----------------------------------------------------------+
| Browser UI           | --HTTPS-> | Tailscale/Caddy (:443 -> 127.0.0.1:4000)                 |
| Editor via SSH       | --:2222-> | SSH bridge      (:2222 -> 127.0.0.1:2222)                |
| Laptop CLI           |           |                                                          |
| (smthrs login <url>) |           | TODO Stack:    main (human squash-merge)                 |
+----------------------+           |                  |                                       |
                                   |                  T1 (In review, open PR, merges first)   |
                                   |                  |                                       |
                                   |                  T2 (Working, draft PR)                  |
                                   |                  |                                       |
                                   |                  T3 (Queued, draft PR)                   |
                                   |                                                          |
                                   | Secrets: branch machines hold placeholders; host sends   |
                                   | real API keys only to the bound provider host.           |
                                   +----------------------------------------------------------+
```

_Self-hosted Mac topology: team laptops reach the LaunchAgent over Tailscale or Caddy HTTPS and SSH, driving an ordered TODO stack with host-bound secret placeholders_

## Prerequisites

Prepare the host Mac and GitHub repository before installing (see [Install Smithers](https://smithers.sh/docs/installation/) for the full checklist):

- Apple Silicon Mac on macOS 15 or later, with Homebrew and at least **44 GiB** free on the state volume.
- A GitHub repository with `main` as its default branch and **squash merging enabled**.
- Coding model access (a provider API key or ChatGPT sign-in) plus an AI Gateway key for Decisions.

## Install and start the host

Install the host package and verify it is running:

```sh
brew install smithersai/tap/smithers
smthrs host start
smthrs host status
```

To expose the install on your LAN, bind `0.0.0.0` and pass your Mac's LAN origin:

```sh
smthrs host start --bind 0.0.0.0 --origin http://studio-mini.local:4000
```

`smthrs host start` prints a one-time setup URL (localhost on the Mac, or the configured LAN origin). Keep that token private. If the host restarts mid-setup, completed steps are preserved; open the fresh URL printed on restart if the previous token expired.

### Complete the setup card

Work through the seven cards in order:

1. **Address:** pick **This Mac** or the network origin your team will open.
2. **GitHub App:** create the App through GitHub's manifest flow so the chosen callback URL is registered before sign-in.
3. **Owner sign-in:** sign in through the new App to claim the install and invalidate the setup token.
4. **Repository:** install the App on your repository. If the `main` or squash-merge check fails, update GitHub settings and choose **Retry**.
5. **Model access:** configure the coding model, an optional fast-model key (falls back to the coding model if omitted), and the AI Gateway key for Decisions.
6. **Source ready:** you can ask repository questions as soon as source sync finishes.
7. **Machine ready:** wait for this indicator before launching coding work.

## First TODO to Merged

Open Chat with `Cmd-K` on macOS (`Ctrl-K` on Windows/Linux). Run `/help` for the command list or `/docs` to open documentation.

1. **Ask a question** about the codebase and click the attached file cards to verify citations.
2. **Create a TODO:** open `/todo.new`, describe one small change, and choose **Append**.
3. **Track its lifecycle:** the card advances through `Queued -> Starting -> Working -> In review`. Answer any **Needs you** prompt on the branch, or use **Steer** to add guidance mid-run.
4. **Handle outside pushes:** if someone pushes to the branch externally, an owner or maintainer can choose **Discard** on the card to target the displayed commit (Git history is kept).
5. **Review and merge:** open the diff, verification results, GitHub checks, and pull request (**on GitHub**). When ready, choose **Merge** in the app and confirm.

People merge; agents never approve or merge. The TODO switches to **Merged** once GitHub confirms the squash merge, and a learning run follows.

### Read the TODO stack

Open `main`'s conversation to inspect the ordered stack. `main` stays pinned at the top; TODOs merge in sequence below it. Only the front TODO (`In review`) has an open pull request; later items stay draft pull requests until their turn. Background runs appear beneath the stack.

```text
main
  |
  T1  (In review, open PR -- merges first)
  |
  T2  (Working, draft PR -- merges after T1)
  |
  T3  (Queued, draft PR -- merges after T2)
```

## Members and secrets

### Team roles

Open `/members` and add teammates by GitHub username (they must have write access or higher on the GitHub repository). Teammates open the configured install URL and sign in with GitHub.

| Role | Branch work | Manage members & merge | Can be removed |
| --- | --- | --- | --- |
| **Owner** | Yes | Yes | No (cannot be removed or demoted) |
| **Maintainer** | Yes | Yes | Yes |
| **Member** | Yes | No | Yes |

### Secrets and egress binding

Open the **Secrets** card to configure values needed by checks, scoped to **all branches** or **main only**. Never put credentials in prompts, flow source, or committed files.

- All-branches secrets appear inside branch machines as environment variables. Set **Path** to also mount a secret as a file (for example `~/.config/anthropic/key` or under `/run/smithers/files/`).
- Known model provider keys (such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) are bound to their provider's host: the branch machine receives only a placeholder, and the Mac host injects the real key only on outbound requests to that provider.
- Personal ChatGPT or Claude sign-ins stay on your own terminal and are never copied onto branch machines.

## Connect an editor or laptop CLI

### SSH from your editor

Add your public SSH key in member controls, then connect to any branch machine:

```sh
ssh -p 2222 <branch>@<install-host>
```

Edits over SSH share the exact working copy used by the app, branch terminals, and coding agent. Branch terminals arrive pre-authenticated to Smithers as you with the Smithers skill installed.

### Sign in from a laptop

Install the CLI on your laptop and authenticate against your Mac host:

```sh
smthrs login https://smithers.example.com
```

Complete browser sign-in. Your laptop agent gets a delegated credential attributed to you; it cannot approve, merge, or move `main`.

## Put HTTPS in front

Plain HTTP works on a trusted LAN, but sends session cookies unencrypted. Use HTTPS for remote access and browser notifications.

In **Settings**, the owner configures the bind address (loopback by default) and public origins. Add your HTTPS origin and register its exact GitHub App callback URL (`<origin>/api/auth/github/callback`) before signing in over HTTPS.

### Option A: Tailscale serve (same Mac)

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4000
tailscale serve --bg --tcp=2222 tcp://127.0.0.1:2222
```

Add the printed HTTPS URL as a public origin. The install trusts `X-Forwarded-Host` only from loopback. TCP port `2222` carries SSH separately.

### Option B: Caddy (same Mac)

Point your DNS name at the Mac and configure Caddy:

```text
smithers.example.com {
    reverse_proxy 127.0.0.1:4000 {
        header_up Host {http.request.host}
        header_up X-Forwarded-Host {http.request.host}
    }
}
```

Set `https://smithers.example.com` as a public origin. A proxy on a separate host must preserve the original `Host` header (forwarding headers from non-loopback hosts are ignored). Restrict network ingress to your team.

## Restart, backup, and recovery

The host runs as a per-user `launchd` LaunchAgent inside the installing user's login session (Hypervisor.framework requires a login session rather than a root daemon). Enable macOS automatic login for that user if the host must recover unattended after a reboot, then confirm **Machine ready**.

```sh
smthrs host backup
smthrs host upgrade
```

:::note[Maintenance availability]
`host backup`, `host upgrade`, and `host restore` currently refuse with `host_maintenance_unavailable` until the install's recovery providers are composed. A refusal is not a completed backup or upgrade.
:::

Completed backups write to `$STATE/backups/<version>-<UTC ts>/`, where `$STATE` is `~/Library/Application Support/Smithers`. Keep backup directories private: they hold the install key and member data. Never restore from a `.partial-` directory.

### Move an install to another Mac

Stop **both** the original and destination installs first so two hosts never operate on the same repository concurrently:

```sh
smthrs host stop
smthrs host restore /Users/will/Backups/smithers
```

Replace `/Users/will/Backups/smithers` with the directory printed by a completed backup. Restore verifies backup hashes and version compatibility; interrupted work resumes or offers **Retry**. Do not restart the original install while the restored host is running.

## Open the wiki in Obsidian

In **Settings**, set **Obsidian folder** to an existing absolute path owned by the install user outside `$STATE` (for example `/Users/will/Vault`), then open that folder as an Obsidian vault. Edits sync bidirectionally every minute while teammates use the wiki in the app.

## Related references

- Gateway endpoints and authentication: [HTTP API reference](https://smithers.sh/docs/reference/http-api/).
- Customizing how flows are authored: [Flows reference](https://smithers.sh/docs/flows/#sdk-file-flows).
