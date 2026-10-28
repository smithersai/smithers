---
title: First run
status: in-review
area: chat
owner: first-run
updated: 2026-10-27
links: [../features/first-run.md, ../decisions/0121-first-run.md, ../decisions/0122-who-may-ask.md, ../features/chat.md, ../features/sign-in.md, ../features/personal-model.md]
---

A real user, relayed by Will on 2026-10-27 about 09:15: "just logged in to see and can't seem to start conversations and
it's not obvious what to do next based on the landingpage / first page up on sign in (onboarding i recall was way more
guided when i last logged in)". Library catalog: `@smthrs/ui` (Button, the app's components), `@smthrs/effect-tanstack-db`
(the first run's row and its follower), Effect `Metric` and logging (the records).

## What a new person saw (read from the code at main 96628360)

| Who | `/` | `/app` | Enter |
|---|---|---|---|
| Signed out | Wordmark, "Automate maintaining your codebase", Get started for free, GitHub | The wordmark, and at the foot "Sign in to ask Smithers." with no button; the sign-in link is only in the header | Nothing: there is no composer |
| Signed in, a Guest or no role on `GITHUB_REPOSITORY` (any stranger on smithers.sh, where it is `smithersai/smithers`) | Open Smithers, GitHub | The wordmark, and at the foot "Members can ask Smithers." with no action. The team's home conversation is not theirs to view | Nothing: there is no composer |
| Signed in, a Member, no model of their own (the deployment's model is off, decision 0099) | Open Smithers | The team's home conversation, and at the foot "Add your model" with Open settings | Nothing: there is no composer |
| A Member with their own model | Open Smithers | The home conversation and a Chat ⌘K button at the foot. A new conversation needs `/new owner/repo` typed into the composer | Asks in the team's home conversation |

**A stranger can't start a conversation anywhere on smithers.sh, and installing the GitHub App on their own repository
changes nothing.** Every route a conversation needs checks the Member role on the deployment's own repository, the
session's role (`worker/Actor.ts` `canAsk`, `canClone`): asking (`worker/Chat.ts` `mayAsk`, before the conversation's
own access), the model endpoint (`worker/ModelEndpoint.ts`), the answer routes (`worker/Answers.ts`), saving their own
model (`worker/personal/Api.ts`) and cloning (`worker/RepoApi.ts`), which `/new` needs first: it makes its branch on
the repository's Code Storage mirror. Decision 0079's per-repository roles reach making a branch and a branch's access
(`worker/branch/Access.ts` `isMemberOn`), but with no mirror there is no branch, and `mayAsk` refuses first anyway. Who
may ask is an open question for Will (rulings §18); the question below asks him.

## Two designs

**A. A first-run list on `/app`.** Up to three steps, each a mark (its number, or ✓ once done) and a short title, the
current one with its button: Sign in (Sign in with GitHub), Add your model (Open settings), Ask Smithers (Chat ⌘K).
Shown until the person has a conversation of their own. A person who may not ask sees Sign in done, then "Members can
ask Smithers.". Needs a row the list reads, worked out by a follower from sign-in's, your model's, your conversations'
and chat's rows, plus a session answer that says, signed out, whether the deployment's model is off, so the steps don't
change count at sign-in.

**B. The composer guides each missing prerequisite where it would be.** Keep `ComposerGate`'s states, add the missing
sign-in button to "Sign in to ask Smithers.", and leave the rest. About ten lines.

**Chosen: A, in the composer's place.** B is smaller but doesn't solve the report: a Member already saw B's states
(Add your model, then Chat ⌘K) and still couldn't tell what to do, and a stranger still gets one line with no path.
A shows the whole path at once, what's done and the one next action, which is what "way more guided" asks for and what
the old app's Set up card did (`apps/app/src/mainview/cards/views/SetupView.tsx` at 78407fce59dd: an ordered list with
a numbered or ✓ mark and one action per step). A takes the gate's place while it shows, so the page never offers the
same button twice, and the composer's own Chat ⌘K is step 3's button, so ⌘K and every existing composer path stay as
they were. Hidden once done: a list whose every step is done has no action left (MINIMAL TEXT).

Why core, not a plugin (PLUGIN-1): the list is the composer gate's own prerequisites shown together: sign-in, the
person's model and the composer, all core state the gate already reads. As a plugin it would need that state exported
as a core query and the composer drawn in a slot, the public interface growing to carry the core's own gate, for a
feature with no flow or data of its own.

## Built

- `src/features/first-run/`: `firstRunOf` (pure), the `first-run` row and its follower, `press`, and the views
  (`FirstRunSteps`, `FirstRunGate`).
- `/app` (`AppShell`): the list just above the composer's place; the gate hidden while a step before Ask shows.
- `GET /api/auth/session` signed out now answers `hostedModel` too.
- Records: `first_run.step` and `smithers_web_first_run_steps {step}` when the shown step changes; `first_run.press`
  and `smithers_web_first_run_presses {step}` for Open settings.
- Local dev: newcomers, `smithers_dev_person=newcomer-<id>`, each a Member nobody was before, so the first-run spec is a
  brand-new person on every run.

## Decided: who may ask (AUTH-8)

Will, Telegram 2026-10-27 13:02, "Use best judgement", on the lead's recommendation, option (2) below. Built by the
`who-may-ask` builder in [decision 0122](../decisions/0122-who-may-ask.md): a Member or above of the conversation's
repository asks there with their own model, saving a model needs only sign-in, the deployment's model answers only
Members of `GITHUB_REPOSITORY`, and one person's branch machines have 4 hours a UTC day unless they are one of its
Members. The first run's last step for a stranger is Open your repository (a field, Open and Install), never "Members
can ask Smithers.".

## Asked of Will (decision queue, answered)

**Who may ask Smithers on a deployment: a Member of its own repository, or anyone signed in with their own model, in
conversations on repositories where they are a Member?** Options: (1) keep Members of `GITHUB_REPOSITORY` only, and add
people as collaborators there (a stranger keeps seeing "Members can ask Smithers."); (2, recommended) a person asks with
their own model in a conversation on any repository where they are a Member or above, through `RepoRoles` (decision
0079), and saves their own model once signed in; the team's home conversation stays Members of `GITHUB_REPOSITORY`;
(3) anyone signed in asks anywhere. Confidence in (2): 60%. It spends no deployment model money (their own key), but
each stranger's clone and branch spends Code Storage and sandbox budget (AUTH-5, ARCH-13), which is Will's money.
What raises it: Will's word on whether strangers may spend Code Storage and sandboxes before the sandbox budgets ship.

## Proof

See [first-run.md](../features/first-run.md#tests). The lander runs `e2e/first-run.spec.ts` against production after
the deploy: signed out it checks step 1; as the test account it checks the steps done, or the list gone and Chat ⌘K.
