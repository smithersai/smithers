# Projects on Home

Open `/app` while signed in to see your saved projects across organizations. Each row links to its Workbench and Runs. A project can appear before it has a run or a Smithers import. Home chat, its keyboard shortcut, Conversations, and the existing Queue and Fleet permissions are part of the same shell.

The list is private to your signed-in account. Every device signed in to that account reads the same roster from the server. The tab clears the previous counts when the account or its authority changes. When a roster or summary read is refused, the tab hides it and checks the session again.

| Field | Source |
| --- | --- |
| Open TODOs | The project's stack, counting TODOs with an open position |
| Needs attention | Failed TODOs, TODOs in review with a confirmed non-draft pull request, and plan nodes blocked on Will (`blocked_on_will`) |
| Open plan nodes | Plan nodes whose status is other than `done` |

Counts require Member access to that repository and respect the private operations policy. A zero means the source answered and found no matching items. A missing draft status or unreadable source leaves the attention total unavailable. Completed reads stay visible if other reads hit the deadline. Projects are ordered by known attention totals, highest first, followed by projects with unavailable totals.

## Save a known project

Enter `owner/repository` in **Repository** and press **Add project** or Enter. The app shows when the write is pending, clears the field and refreshes the roster after the write succeeds, and keeps the entry available for retry on failure. Saving a repository again keeps one entry. **Refresh** loads changes made on another device or in a project. A pending addition keeps its result when you leave Home and return on the same account.

The app’s Add project form runs the person-only `app/project/add` flow after a trusted button press, including keyboard activation. Its step sends `POST /api/me/projects` with JSON `{"project":"owner/repository"}` through the account-bound transport. The request uses the owner’s existing session and carries the expected account from the form. A successful request returns `200` and the canonical lowercase `project`. The route rejects an account mismatch, a delegated credential, a malformed path, or extra payload fields. The `projects.add` span and log, and the `smithers_projects_adds` counter, record the outcome by code.

`GET /api/me/projects` returns the owner’s `projects` array. `GET /api/me/projects/summaries` adds the access state and counts for those entries. Summaries return up to eight projects per request. When the response includes `nextAfter`, the tab requests the next page using `?after=` and displays counts as each page arrives. Both reads use private, non-cacheable responses. Admission writes a personal reference without consulting GitHub, changing a repository's access, or starting an import.

See [decision 0177](../decisions/0177-personal-project-roster.md).
