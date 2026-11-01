# First run

On an empty `/app`, signed-out people see the steps to their first conversation: each a mark (✓ once done, else its
number), a title, and the current step's button. Signed-in people who need a model see the shared **Add your model**
toast with **Open settings** instead. No first-run list appears beside conversation history (FE-23). Decision
[0121](../decisions/0121-first-run.md); design and the report it answers: [work/first-run.md](../work/first-run.md).

```
empty /app, signed out                 signed in, no model        signed in, ready to ask
 1  Sign in [Sign in with GitHub]        [Add your model             ✓ Sign in
 2  Add your model                        Open settings ×]          ✓ Add your model
 3  Ask Smithers                        (header overlay)             3 Ask Smithers
                                                                          [Chat ⌘K]
```

Once their model is ready, someone who may not ask in `/app` sees **Open your repository** with `owner/name`, Open and
Install. The model setup toast and conversation gates use the same model readiness.

## What a person sees

- **Sign in** is current for anyone signed out. Its button is sign-in's own link, returning to this page; while it
  shows, the header offers none, so the page has one sign-in action (`FirstRunAccount`).
- **Add your model** shows only while the deployment's own model doesn't answer the person
  ([hosted inference](model-endpoint.md#hosted-inference), decision 0099: off, or on for its own Members only), and is
  current for someone who saved none. Signed in, the list yields to the shared toast; Open settings goes to
  Settings ▸ Your model ([Your model](personal-model.md)). Chat stays disabled where a model is required.
- **Ask Smithers** is current once the person may ask. Its button is the composer's own Chat ⌘K, under the list; opening
  the composer, by the button or ⌘K, leaves the composer alone in its place.
- **Open your repository** takes the place of Ask Smithers for a signed-in person who may not ask in `/app`'s
  conversation, the deployment's own repository's ([decision 0122](../decisions/0122-who-may-ask.md), ruling AUTH-8),
  once their model is ready and no conversation history is showing: a field for `owner/name` or its GitHub URL, Open, which opens the repository's page,
  and Install, the Smithers GitHub App's installation on GitHub (`install` in the session answer), when the deployment
  signs in with the App. They ask on a branch of a repository where they are a Member or above.
- **Gone for good**, for a person who may ask in `/app`'s conversation, once they have had a conversation: asking in the home conversation or opening a branch adds
  one to [their conversations](conversations.md), archived or not. Any visible conversation history also hides the
  list, signed out too. Before Ask, the current prerequisite has one action: Sign in in the list or Open settings
  in the shared toast.
- **Never a wait on the network for the composer.** Until the device has restored and synced the person's
  conversations, a person who may ask keeps the composer, and one who may not sees nothing there yet. A visitor's rows
  never sync, so a visitor sees the steps at once.
- Branch pages keep the [chat](chat.md) gate, decided by the person's role on the branch's repository.

The copy is the step titles (`Sign in`, `Add your model`, `Ask Smithers`, `Open your repository`), the shared toast's
`Open settings`, the repository step's `Repository` field (`owner/name`), `Open` and the repository page's `Install`, and
`Done` for a ✓'s name (`src/features/first-run/contract.ts`). Nothing else (MINIMAL TEXT).

## How it works

```
sign-in's session row + confirmed row ─┐
your model's rows (ready?)              ├─ follower ─ firstRunOf ─▶ first-run row (local) ─▶ FirstRunSteps, FirstRunGate,
your conversations' rows (loaded?)      │                                                    FirstRunAccount (/app)
chat's composer row (open?)            ─┘   each step it comes to show ─▶ first_run.step, smithers_web_first_run_steps
```

- `src/features/first-run/` follows [state.md](../state.md): `view.ts` (pure: `firstRunOf`, `conversationsOf`, `ownOf`,
  `showsGate`, `offersSignIn`), `schema.ts` (the one row), `store.ts` (`FirstRunStore`: the row and its follower),
  `actions.ts` (`press`), `firstRun.ts` (`FirstRun`, what frontends get) and `components/`.
- The follower reads what `ComposerGate` reads, through `composerAccess` (src/features/auth/contract.ts), so the two
  never disagree on who may ask. `appLayer` builds `FirstRun` above every store it reads (`src/boot.ts`).
- Should the follower ever stop, it records `app.unhandled` (`feature: first-run`) and writes the row `hidden`, so the
  composer's place shows the gate as it would without a first run.
- `GET /api/auth/session` answers `hostedModel` signed out too ([sign-in](sign-in.md#routes)), so a visitor sees as
  many steps as they will have once signed in; signed in, whether it answers them, and `install`.
- Core, not a plugin: the steps are the composer gate's own prerequisites, state the gate already reads (decision 0121
  §5, PLUGIN-1).

## Observability

| Record | Kind | Fields |
|---|---|---|
| `first_run.step` | log and span | `step` (`sign_in`, `model`, `ask`, `repository`), `steps` (how many the list shows), `feature` |
| `smithers_web_first_run_steps` | counter | `step`: each time a tab's first run comes to show it |
| `first_run.press` | log and span | `step`: Open (`repository`) from the list; model setup now records `notifications.model {act: open}` (sign-in's link counts as `smithers_web_sign_in_presses`, Chat ⌘K as `smithers_web_composer_opens`) |
| `smithers_web_first_run_presses` | counter | `step` |

`smithers_web_first_run_steps {step: repository}` is how many signed-in people the first run sends to a repository of
their own. No record carries a login, a key, a repository's name or anything typed.

## Tests

| Test | Proves |
|---|---|
| `src/features/first-run/view.test.ts` | every state: a visitor, a Member without a model, a Member who may ask, a Guest at Add your model and at Open your repository, with or without conversations; the repository field's names; Add your model only while the deployment's model is off or unknown; hidden once any conversation, archived too; the composer open at Ask; nothing while who the person is isn't known; the composer kept while conversations load; the gate's place and the header's sign-in; the row's equality |
| `src/features/first-run/firstRun.test.ts` | the whole app on a Node device against ChatApi's real routes: a visitor's steps by the deployment's model, a Guest who saves a model and is at Open your repository, a Member with the model on, a Member who saves a model, opens and hides the composer, asks and never sees the steps again (another tab too), every record and none carrying a key or a question, and the follower stopping |
| `tests/FirstRun.test.ts` | the views' markup in each state: the one sign-in link, Done marks, no inline signed-in model setup, the composer's place, a Guest's repository step with its field, Open and Install, and no Install without an App |
| `worker/SignIn.test.ts` | the session route's `hostedModel` signed out, by an Admin's setting and when Postgres can't say; local development's newcomers and their run credentials |
| `e2e/first-run.spec.ts` | locally, a brand-new person (`newcomer-<word>`) signed out sees Sign in, signs in from the step, opens Chat, gets the scripted `hello` agent's answer, and never sees the steps again after a reload; everywhere, production included, a visitor's first page and a signed-in, set-up account's (steps done, or none once it has a conversation, counted on its Conversations page) |
| `e2e/sign-in.spec.ts`, `sign-in-return-path.spec.ts`, `chrome-visitor.spec.ts`, `slash-commands.spec.ts` | the sign-in prompt on `/app` is the first run's Sign in step (`e2e/firstRun.ts` `signInPrompt`) |
| `e2e/who-may-ask.spec.ts` | locally, a brand-new `owner-<word>` with no role on the dev server's repository signs in, adds their model, opens octocat/Spoon-Knife from the repository step, opens its README into the branch's workspace and gets the scripted answer there; a `reader-<word>` is never stopped on `/app` and reads Members can ask Smithers. on Spoon-Knife's main; on a deployment, the test account, a Member of its repository who only reads smithersai/vibelang, reads Members can ask Smithers. on vibelang's main and has no composer there |

## Model setup now overlays the page (FE-23, 2026-10-31)

The signed-in current model step and the old centered composer gate now yield to the shared **Add your model** toast with **Open settings**. The signed-out list on an empty `/app` stays as above. A conversation never gives its space to a model setup block. Chat stays disabled where a missing model prevents asking; saving a usable model removes the notice and restores Chat. See [notifications](notifications.md#model-setup-fe-23) and the amendment to decision 0121. The local notice uses the existing anchored `Notices` owner on every surface.
