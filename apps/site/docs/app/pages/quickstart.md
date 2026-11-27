---
title: "Quickstart"
summary: "Take a five-minute tour of smithers.sh: open any GitHub repo by URL, inspect its files and issues, sign in with GitHub, add your model, and ask Smithers."
---

You do not need an account, a config file, or a local install to explore Smithers. In the next five minutes you will open a live repository on `smithers.sh`, browse its code and issues, sign in with GitHub, connect your model, and ask your first question.

![The five-minute tour: swap github.com for smithers.sh to read any public repository, then sign in with GitHub to contribute](diagrams/quickstart-tour.svg)

**What you need:** a browser and a GitHub account to sign in at Step 5. To open a private repository, you need read access to it on GitHub; to ask Smithers inside a repository, you need write access or higher.

## Step 1. Land on smithers.sh

Open [smithers.sh](https://smithers.sh). Choose **Get started for free** to sign in, or jump straight to any public repository URL in Step 2.

![The smithers.sh home page with Get started for free](images/welcome-home.webp)

## Step 2. Swap the hostname to open any repo

Smithers mirrors GitHub's URL path layout 1-to-1. Replace `github.com` with `smithers.sh` in any repository address:

```text
https://github.com/smithersai/vibelang
                   |
                   v
https://smithers.sh/smithersai/vibelang
```

Open `https://smithers.sh/smithersai/vibelang`. The repository opens on **Home**; choose **Code** to browse the file tree and switch branches.

![The smithersai/vibelang repository on its Home tab](images/quickstart-repo-home.webp)

:::note[There are no dumb questions]
**Q: What happens if a repository has never been opened on smithers.sh?**
A: Smithers tells you plainly what is true. A repository not yet cloned offers **Sign in to clone**. A missing or inaccessible repository shows **Not found**; a failed lookup shows an error.

**Q: Does browsing a public repo touch GitHub?**
A: No. Signed-out views are strictly read-only. Nothing writes to GitHub until a signed-in person explicitly acts or merges a pull request.
:::

## Step 3. Drill into a file and jump back

Choose **Code**, then click a folder or file. The breadcrumb path stays pinned at the top of the viewer; click the repository name in that path to jump back to the root tree.

![package.json in smithersai/vibelang on smithers.sh, with the file's path at the top (1)](images/quickstart-file.webp)

## Step 4. Switch to Issues and Pull requests

Choose **Issues** to list open and closed issues, or **Pull requests** to inspect open PRs. Click any issue to read its full body and comments.

![The Issues tab of smithersai/vibelang on smithers.sh: Issues (1) and Pull requests (2), with each issue's author hidden](images/quickstart-issues.webp)

## Step 5. Sign in with GitHub

From the home page, choose **Get started for free**. Before your first conversation, the app shows a compact setup checklist above the chat: **Sign in**, **Add your model**, and **Ask Smithers** (or **Open your repository**), checking each step off as you finish.

Choose **Sign in with GitHub**. GitHub authenticates you and asks you to authorize Smithers to read your account, email address, and repository access.

![GitHub's sign-in page, opened from Sign in on smithers.sh](images/quickstart-sign-in.webp)

## Step 6. Add your model and ask

Smithers answers with your own model key (see [Settings](settings.md) for tier details):

1. On **Add your model**, choose **Open settings**, enter your provider's **Base URL**, **Key**, and model under **Your model**, and choose **Save**.
2. Return to chat. If you have write access to the current repository, choose **Chat** on **Ask Smithers**, type a question, and press Enter.
3. If the current repository is read-only for you (it shows **Members can ask Smithers.**), choose **Install** on **Open your repository** to add the Smithers GitHub App to a repository of yours, enter `owner/name`, choose **Open**, then **Clone**. Open any file or folder to chat beside it.

Once you ask your first question, the onboarding checklist disappears.

## What you just unlocked

| Signed out | Signed in with GitHub + your model |
| --- | --- |
| Read files and folders on public repos | Open private repositories you can read on GitHub |
| Browse open and closed issues and PRs | Clone your repositories and chat with Smithers |
| Explore `smithers.sh` with zero setup | Create personal flows, run `/` commands, and review changes |

## Next steps

- Configure personal model tiers, spend alerts, and sandbox limits: [Settings](settings.md).
- Run a coding agent locally on your own Codex subscription: [Run agents on your Mac](local-quickstart.md).
- Understand why flows plan first and survive crashes: [How durable flows work](durable-flows.md).
- Build personal flows and explore chat commands: [Flows reference](flows.md) and [Chat commands](commands.md).
