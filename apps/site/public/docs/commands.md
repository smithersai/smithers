# Chat commands

> Slash commands, arguments and minimum roles.

In Chat, type `/` to list commands available to you. Type to filter; Tab completes a row; Enter runs a complete command. Missing arguments stay in the composer. The last text argument takes the rest of the line. Brackets below mean optional arguments.

The composer is available to Members and above. Minimum roles below describe each command's permission; they do not give Guests a composer. Commands operate in the current conversation unless they ask for a repository.

## Commands

`repo` means `owner/name`; issue and TODO numbers are positive integers.

| Command | Arguments | Minimum role | Action |
| --- | --- | --- | --- |
| `/theme` | `light` or `dark` | Anyone | Set this device's theme. |
| `/navigate` | app path | Anyone | Open a page in this tab. |
| `/copy` | none | Anyone | Copy the latest finished answer. |
| `/new` | `repo [branch]` | Member | Start a conversation. |
| `/web` | `url [embed\|tab]` | Member | Open a web page. |
| `/docs` | `repo query` | Member | Find repository documentation. |
| `/repo` | `repo` | Member | Open the repository view. |
| `/issues` | `repo` | Member | Show the repository's issues. |
| `/edit` | none | Member | Return the latest unsent question to the composer. |
| `/clone` | `repo` | Member | Clone a repository. |
| `/flow.new` | `name request` | Member | Draft or edit a personal flow. |
| `/flow.run` | `name [input]` | Member | Run the latest saved revision. |
| `/branch.new` | `repo branch` | Member | Create and track a branch. |
| `/publish` | `title` | Member | Publish this branch's changes as a pull request. |
| `/branch.update` | none | Member | Update the current branch. |
| `/branch.resync` | none | Member | Resync the current branch. |
| `/issue` | `repo title` | Guest | Open an issue. |
| `/comment` | `repo number comment` | Guest | Comment on an issue. |
| `/triage` | `repo number accept\|reject [reason]` | Member | Set triage and pin the decision. |
| `/issue.commitment` | `repo number now\|next\|later\|none` | Maintainer | Set implementation commitment. |
| `/triage.run` | `repo number` | Member | Unpin and run automatic triage again. |
| `/triage.enable` | `repo [dailyTokens]` | Maintainer | Enable automatic triage. |
| `/triage.pause` | `repo` | Maintainer | Pause automatic triage. |
| `/todo.new` | `repo prompt` | Member | Draft a private TODO. |
| `/todo.issue` | `repo issue` | Member | Draft a TODO from an issue. |
| `/todo.drop` | `repo number` | Member | Request dropping a committed TODO. |
| `/run` | shell command | Member | Run on the current branch's sandbox. |
| `/read` | file path | Member | Read a sandbox file. |
| `/write` | `path content` | Member | Replace a sandbox file. |
| `/ls` | `[path]` | Member | List sandbox files. |
| `/status` | none | Member | Show sandbox changes. |
| `/diff` | `[paths]` | Member | Show the sandbox diff. |

## Plugin commands

Enabled plugins can contribute commands. The shipped queue and bug plugins add:

| Command | Arguments | Minimum role | Action |
| --- | --- | --- | --- |
| `/queue` | none | Member | Open the decision queue. |
| `/bug` | none | Guest | Open the bug report form. |
| `/bugs` | none | Guest | Open the bug inbox. |

Shared writes are checked again by the server. Requested work continues in the background; follow its toast and run for completion or failure.
