# 0099: People's own models first; hosted inference behind a flag

2026-10-25. Accepted.

Will, 2026-10-25 13:28 PDT (Telegram): "Please get it working with byok prioritize byok over our hosted inference our
hosted cerebras inference is now a wip feature flagged and not being released or documented until post initial
release".

## Decision

1. **A person's own model answers everything they cause.** With a model saved (decision 0096), it answers every role
   of every call the person causes: their chat (`agent`), the views it renders (`renderer`), its judgments and Jev
   (`judge`), the memory opening's judge, the timeline's summaries (`summary`), their TODO runs (`coding`), and the
   review of their TODO's pull request. This holds whether hosted inference is on or off. It replaces decision 0096's
   amendment of the same day, under which summaries stayed on the deployment's model.
2. **Hosted inference is a flag, off for a deploy.** The deployment's own model answers a person without a model of
   their own, or work nobody owns, only while hosted inference is on. The Admin's setting is the `hosted_model` row
   (`admin/SetHostedModel`, Admin in person), read on every call, so a change needs no deploy. Without a row,
   `HOSTED_MODEL_ENABLED` decides, off unless set; `alchemy dev` turns it on, so a laptop and the scripted end-to-end
   tests answer with no key of their own.
3. **Off, nothing silently fails.** The model endpoint refuses a call with no model to answer it `409 no_route`, "Add
   your model in Settings to ask Smithers.", and logs `hosted_off`; it never answers on the deployment's model. The
   session says so (`GET /api/auth/session`'s `hostedModel`), so where the composer would be, a person without a model
   of their own sees "Add your model" and a button to Settings. Admin features that need the deployment's model say
   they are off: the triage switch reads "Triage off: needs hosted model".
4. **Who pays for work no person causes.** The acting person's model when there is one, else nothing runs.
   - The timeline's summaries are dispatched from the tab of the person viewing the conversation, a shared branch's
     included, so the viewer's model writes them; a viewer without one gets the rail's own labels (the summary role's
     refusal stops the tab's summaries, docs/features/timeline.md).
   - Triage on a new issue is nobody's: while hosted inference is off its judge is refused and triage abstains with
     the refusal's code (`triage_decisions.abstained`); the switch says triage is off.
   - A head's review is its TODO owner's (`Checks.Services.judgeFor`).
5. **Hosted inference is not released or documented** until after the initial release, beyond the operator's notes in
   docs/features/model-endpoint.md, which mark it a work in progress. User-facing docs describe bringing your own key
   as the way to use Smithers. The backup provider for it is parked (docs/work/hosted-model-backup-provider.md).

## Consequences

- Production answers no one who hasn't saved a model, until an Admin turns hosted inference on. The production
  end-to-end tests that need an answer save the test account's own model first.
- A person's key pays for their summaries: the timeline asks for one per settled entry its window shows, once per
  device, and stops on the first refusal that every later entry would repeat (decision 0078's lane).
- The deployment's daily budget and spend alerts apply only while hosted inference is on.

## Library catalog

`@smthrs/model-host` and `@smthrs/rpc` as decision 0096 uses them; `@smthrs/flow` for `admin/SetHostedModel`. No new
dependency.
