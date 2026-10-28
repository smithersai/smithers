# 0121: The first run is the composer's place, shown as steps

Date: 2026-10-27. Status: accepted (first-run builder; designed twice in [work/first-run.md](../work/first-run.md)).
Will reviews it with the feature (HOST-3).

## Problem

A person who signed in to smithers.sh couldn't tell what to do or start a conversation (a real user, relayed by Will,
2026-10-27). `/app` showed one line at the foot of an empty page: "Sign in to ask Smithers." without a button, "Members
can ask Smithers." with no action, or "Add your model". Nothing showed the path from sign-in to a first answer.

## Decision

1. **Until a person has a conversation of their own, `/app` shows the steps in the composer's place:** Sign in, Add your
   model (only while the deployment's own model is off, decision 0099) and Ask Smithers. Each shows ✓ once done, or its
   number; the current one has its one button: Sign in with GitHub, Open settings, or the composer's own Chat ⌘K. A
   person who may not ask in `/app`'s conversation, the deployment's own repository's, sees Sign in done, Add your model
   (the deployment's model answers only its Members) and Open your repository: a field for `owner/name`, Open and
   Install, whatever conversations they have, since the composer's place there is never theirs ([0122](0122-who-may-ask.md),
   ruling AUTH-8).
2. **"Has a conversation"** is any row of theirs in `my-conversations`, archived or not: archiving doesn't make anyone
   new. Asking in the home conversation adds it, so the steps go once the first question is taken. Until the device has
   restored and synced the rows, a person who may ask keeps the composer, and one who may not yet sees nothing there;
   nobody's composer waits on the network.
3. **The steps replace the gate while a step before Ask is current**, so no button shows twice. At Ask, the composer's
   Chat ⌘K sits under the list, and the list hides once the composer opens.
4. **Signed out, `GET /api/auth/session` says whether the deployment's model is off** (`hostedModel`), so a visitor sees
   the same number of steps they will have once signed in.
5. **Core, not a plugin.** The steps are the composer gate's own prerequisites (sign-in, the person's model, the
   composer), core state the gate already reads; a plugin would need that state as a core query and the composer in a
   slot, for a feature with no flow or data of its own (PLUGIN-1).

## Who may ask

Decided by ruling AUTH-8 (2026-10-27) and built in [0122](0122-who-may-ask.md): a Member or above of the conversation's
repository asks there with their own model. The first run takes a stranger to a repository of theirs instead of stopping
them at "Members can ask Smithers.".

## Consequences

- Records: `first_run.step` and `smithers_web_first_run_steps {step}` count which step people see, so the number of
  signed-in people sent to their own repository (`repository`) is measured; `first_run.press` counts Open settings and
  Open from the list.
- The sign-in prompt's words on `/app` are the list's: specs that looked for "Sign in to ask Smithers." on `/app` look
  for the first step. Branch pages keep the gate as it was.
