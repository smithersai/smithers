# First run

The home page shows **Sign in** followed by **Ask Smithers**. A signed-in member can open Chat even when the deployment has no hosted model and they have no saved model. The conversation stays visible while an attached agent answers over MCP. See [chat](chat.md) and [decision 0173](../decisions/0173-byoa-only-mcp-attach-and-jev-config.md).

A signed-in person who cannot ask in the home repository sees **Open your repository**. Enter `owner/name` or its GitHub URL. The repository's role controls whether they can ask there.

Opening the composer hides the steps. After the first stored question, the conversation stays in their place on other devices and after reload. Before the device can confirm its session, it shows the last confirmed role when available.

The device stores the projected steps in the local `first-run` collection. `first_run.step` records the current step and total count, and `first_run.press` records **Open your repository**. Neither records a login, repository name, or message.

The app tests cover role checks, opening the composer without a model, and hiding the steps after the first question. Browser tests exercise sign-in, repository access, and attached answers.
