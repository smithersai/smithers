# 0149: A shared alert channel carries no private content

Status: accepted
Date: 2026-11-02
Decided by: the agent (effectscript-11's call), on a security review of the fleet's alerts

The deployment's email and Telegram channels (`alert_channels`, worker/AlertChannels.ts) are the deployment's: one
Admin sets one list of addresses and one chat, and every alert flow sends there. Nobody's access to a repository is
checked where a message lands. A fleet alert about a private repository sent its TODO's title, its failure text or its
cost, or its runner's name, to every address on that list, including people who never had, or no longer have, access to
that repository. A bug report sent the reporter's login and the page, which can name a private repository. Spend alerts
sent dollars and token counts.

## Decision

1. **A shared channel's message names only the alert's kind, the repository it is about, and a link.** For example:
   `Agent run failed · acme/widgets` with the link to the TODO's page, `Runner offline · acme/widgets`, `Bug report`,
   `Sandbox spend`, `Model spend` and `Database connections high`, each with its link into the app.
2. **The rest stays behind the link.** Titles, costs, prompts, runner names, error text, logins and routes appear only on
   the page the link opens. That page asks for sign-in and checks the reader's access, as a GitHub notification email
   links to a page instead of quoting a private repository.
3. **The type enforces it.** A flow gives `AlertDelivery.deliver` an `AlertDelivery.Notice` (`kind`, `repository`,
   `href`), and `AlertDelivery.wordsOf` writes the message. A flow can't put anything else in it.
4. **The bell is separate.** Bell rows (`notifications`) go to individual people picked by role. Each feature
   decides what its rows carry. Spend and bug rows go to Admins with live sessions and keep their detail.

## Consequences

- An Admin reading a Telegram message opens the app to see what failed and why. That is one more step than before.
- The repository's name still reaches the channel. An Admin sets the channel's addresses, and the name is what makes
  the message useful without content.
- Database load and spend messages lose their numbers. The numbers stay in the logs and metrics (`database.connections`,
  `model.spend.alert`) and in the app.

Libraries: none new.
