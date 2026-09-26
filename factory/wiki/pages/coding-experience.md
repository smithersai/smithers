# A linear story with recursive detail

This page records intended product interactions. It is a design contract, not a claim that every control or comparison below is implemented.

## Lead with the work people recognize

Intent: present one ordered sequence of Changes with a short explanation of what the agent just did and what it expects to do next. Keep predicted edits, actual execution and validation facts separate. A completed procedure must not be shown as a passing check unless its recorded domain result supports that.

Intent: keep the selected Change visible when opening detail, with its atomic commits, read/write predictions and required checks. Parallel execution should still read as one linear history. An earlier repair should update that story and show which later revisions need new evidence.

## Make inspection behave like a debugger

Intent: selecting a turn, Change, check or native execution sets the context for every detail pane. Show the recorded source revision, inputs, results, failures, parent/child edges and original event. Preserve the reader's historical cursor so later success cannot leak into an earlier view. Keep the stable native JJ identity separate from the immutable commit revision a check evaluated.

Intent: let the person compare the before and after revision of one Change and return to the compact explanation without losing selection. Recursive graph detail should appear when it explains a dependency or failure.

## Put feedback beside its source

Intent: a retained prototype shows its before/after source and its unvalidated status. Feedback keeps the originating card, source context, text and actor. A queued message is distinct from an accepted revised plan, which only a later native planning result can show.

Intent: completed implementation, validated, vibed, landed and shipped are different product facts, each with its own recorded evidence and controls.

## Prior art

The run-lifecycle lane guide records the references checked on September 8, 2026: Temporal's history UI for progressive summary, compact and raw detail over one history; Chrome's debugger for selection-to-detail inspection; and Graphite's review UI for keeping navigation context beside the focused change. These are interaction inferences from primary documentation, not claims that those products implement mythical history.
