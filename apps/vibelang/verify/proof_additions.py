"""Checked Dafny proof steps, inserted into fresh empty lemmas.

Never saved generated artifacts: insertion only, so every generated declaration, precondition, postcondition and
body stays byte-identical. A lemma lsc fills only with `reveal f();` lines (`//@ opaque`, `//@ reveal`) counts as empty;
its steps go after those lines. Recursive helpers lower as spec-callable Dafny functions whose postconditions live on
fresh empty `_ensures` lemmas; the inductive steps below are how the backend discharges them (pendingCount
precedent). Sandbox runtime traversals stay iterative; exact guard clauses use quantified source positions rather than
calling loop-backed methods inside expressions (the documented method-spec tool boundary).
"""
import re

REVEALS_ONLY = re.compile(r'(?:  reveal [A-Za-z_][A-Za-z0-9_]*\(\);\n)*')

PENDING_COUNT_STEPS = '  if end > 0 {\n    pendingCount_ensures(pending, clientId, end - 1);\n  }\n'

# The issue graph stays a forest (0018, fifth proofs lane): induction over the opaque ancestor measure, which
# these steps unfold only through its contract lemma.
ISSUE_FIRST_FOUND = '''      var i :| 0 <= i < |items| && items[i].number == y && forall j :: 0 <= j < i ==> items[j].number != y;
'''

ISSUE_GRAPH_STEPS = [
    ('lemma issueFirstNumbered_ensures(items: seq<IssueRecord>, number: int, end: int)',
     '''  if end > 0 {
    issueFirstNumbered_ensures(items, number, end - 1);
    if !(exists i :: 0 <= i < end - 1 && items[i].number == number) && items[end - 1].number == number {
      assert forall j :: 0 <= j < end - 1 ==> items[j].number != number;
    }
  }
'''),
    ('lemma issueAncestorStep_ensures(items: seq<IssueRecord>, start: int, steps: int)',
     '''  var y := issueAncestorAt(items, start, steps);
  issueAncestorAt_ensures(items, start, steps + 1);
  issueAncestorAt_ensures(items, y, 0);
  issueAncestorAt_ensures(items, y, 1);
  issueFirstNumbered_ensures(items, y, |items|);
  if y != 0 && exists i :: 0 <= i < |items| && items[i].number == y {
''' + ISSUE_FIRST_FOUND + '''    assert issueAncestorAt(items, start, steps + 1) == items[i].parent;
    assert issueAncestorAt(items, y, 1) == items[i].parent;
  }
'''),
    ('lemma issueAncestorJoin_ensures(items: seq<IssueRecord>, start: int, a: int, b: int)',
     '''  issueAncestorAt_ensures(items, start, a);
  issueAncestorAt_ensures(items, issueAncestorAt(items, start, a), 0);
  if b > 0 {
    issueAncestorJoin_ensures(items, start, a, b - 1);
    issueAncestorStep_ensures(items, start, a + b - 1);
    issueAncestorStep_ensures(items, issueAncestorAt(items, start, a), b - 1);
  }
'''),
    ('lemma issueRootStays_ensures(items: seq<IssueRecord>, steps: int)',
     '''  if steps > 0 {
    issueRootStays_ensures(items, steps - 1);
  }
  issueAncestorAt_ensures(items, 0, steps);
'''),
    ('lemma issueMissingStays_ensures(items: seq<IssueRecord>, steps: int)',
     '''  if steps > 0 {
    issueMissingStays_ensures(items, steps - 1);
  }
  issueAncestorAt_ensures(items, -1, steps);
'''),
    ('lemma issueAvoids_ensures(items: seq<IssueRecord>, start: int, fresh_: int, steps: int)',
     '''  issueAncestorAt_ensures(items, start, 0);
  if steps > 0 {
    issueAvoids_ensures(items, start, fresh_, steps - 1);
    issueAncestorAt_ensures(items, start, steps);
    var y := issueAncestorAt(items, start, steps - 1);
    issueFirstNumbered_ensures(items, y, |items|);
    if y != 0 && exists i :: 0 <= i < |items| && items[i].number == y {
''' + ISSUE_FIRST_FOUND + '''      assert issueAncestorAt(items, start, steps) == items[i].parent;
    }
  }
'''),
    ('lemma issueRootedExists_ensures(items: seq<IssueRecord>, number: int, steps: int)',
     '''  issueAncestorAt_ensures(items, number, steps);
  if !(exists j :: 0 <= j < |items| && items[j].number == number) {
    assert steps > 0;
    issueAncestorAt_ensures(items, number, 0);
    issueAncestorAt_ensures(items, number, 1);
    assert issueAncestorAt(items, number, 0) == number;
    assert issueAncestorAt(items, number, 1) == -1;
    issueMissingStays_ensures(items, steps - 1);
    issueAncestorJoin_ensures(items, number, 1, steps - 1);
    assert false;
  }
'''),
    ('lemma issueLinkFrame_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>, child: int, parent: int, start: int, steps: int)',
     '''  issueAncestorAt_ensures(items, start, 0);
  issueAncestorAt_ensures(after, start, 0);
  if steps > 0 {
    issueLinkFrame_ensures(items, after, child, parent, start, steps - 1);
    issueAncestorAt_ensures(items, start, steps);
    issueAncestorAt_ensures(after, start, steps);
    if forall t :: 0 <= t < steps ==> issueAncestorAt(items, start, t) != child || issueAncestorAt(after, start, t) != child {
      var y := issueAncestorAt(items, start, steps - 1);
      assert issueAncestorAt(after, start, steps - 1) == y;
      assert y != child;
      issueFirstNumbered_ensures(items, y, |items|);
      if y != 0 && exists i :: 0 <= i < |items| && items[i].number == y {
''' + ISSUE_FIRST_FOUND + '''        assert after[i].number == y && after[i].parent == items[i].parent;
        assert forall j :: 0 <= j < i ==> after[j].number != y;
        assert issueAncestorAt(after, start, steps) == after[i].parent;
      } else if y != 0 {
        assert forall j :: 0 <= j < |after| ==> after[j].number != y;
      }
    }
  }
'''),
    ('lemma issueAddFrame_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>, start: int, steps: int)',
     '''  issueAncestorAt_ensures(items, start, 0);
  issueAncestorAt_ensures(after, start, 0);
  if steps > 0 {
    issueAddFrame_ensures(items, after, start, steps - 1);
    forall j | 1 <= j < |after|
      ensures after[j] == items[j - 1]
    {
      assert after[(j - 1) + 1] == items[j - 1];
    }
    issueAncestorAt_ensures(items, start, steps);
    issueAncestorAt_ensures(after, start, steps);
    if forall t :: 0 <= t < steps ==> issueAncestorAt(items, start, t) != after[0].number {
      var y := issueAncestorAt(items, start, steps - 1);
      assert issueAncestorAt(after, start, steps - 1) == y;
      assert after[0].number != y;
      issueFirstNumbered_ensures(items, y, |items|);
      if y != 0 && exists i :: 0 <= i < |items| && items[i].number == y {
''' + ISSUE_FIRST_FOUND + '''        assert after[i + 1] == items[i];
        assert forall j :: 0 <= j < i + 1 ==> after[j].number != y;
        assert issueAncestorAt(after, start, steps) == after[i + 1].parent;
      } else if y != 0 {
        assert forall j :: 0 <= j < |after| ==> after[j].number != y;
      }
    }
  }
'''),
    ('lemma issueSameEdges_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>, start: int, steps: int)',
     '''  issueAncestorAt_ensures(items, start, 0);
  issueAncestorAt_ensures(after, start, 0);
  if steps > 0 {
    issueSameEdges_ensures(items, after, start, steps - 1);
    issueAncestorAt_ensures(items, start, steps);
    issueAncestorAt_ensures(after, start, steps);
    var y := issueAncestorAt(items, start, steps - 1);
    issueFirstNumbered_ensures(items, y, |items|);
    if y != 0 && exists i :: 0 <= i < |items| && items[i].number == y {
''' + ISSUE_FIRST_FOUND + '''      assert forall j :: 0 <= j < i ==> after[j].number != y;
      assert issueAncestorAt(after, start, steps) == after[i].parent;
    } else if y != 0 {
      assert forall j :: 0 <= j < |after| ==> after[j].number != y;
    }
  }
'''),
    ('lemma issueLinkChildFree_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>, child: int, parent: int, root: int, steps: int)',
     '''  var m := steps - 1;
  forall t | 0 <= t
    ensures issueAncestorAt(items, parent, t) != child
  {
    if t >= root {
      issueAncestorJoin_ensures(items, parent, root, t - root);
      issueRootStays_ensures(items, t - root);
    }
  }
  issueLinkFrame_ensures(items, after, child, parent, parent, m);
  issueFirstNumbered_ensures(items, child, |items|);
  var f :| 0 <= f < |items| && items[f].number == child && forall j :: 0 <= j < f ==> items[j].number != child;
  assert after[f].number == child && after[f].parent == parent;
  assert forall j :: 0 <= j < f ==> after[j].number != child;
  issueAncestorAt_ensures(after, child, 0);
  issueAncestorAt_ensures(after, child, 1);
  assert issueAncestorAt(after, child, 1) == parent;
  issueAncestorJoin_ensures(after, child, 1, m);
  assert 1 + m == steps;
'''),
    ('lemma issueLinkAcyclic_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>, child: int, parent: int, root: int)',
     '''  forall i, k | 0 <= i < |after| && k >= 1
    ensures issueAncestorAt(after, after[i].number, k) != after[i].number
  {
    var x := after[i].number;
    assert x == items[i].number;
    if forall t :: 0 <= t < k ==> issueAncestorAt(after, x, t) != child {
      issueLinkFrame_ensures(items, after, child, parent, x, k);
    } else {
      var t :| 0 <= t < k && issueAncestorAt(after, x, t) == child;
      if issueAncestorAt(after, x, k) == x {
        issueAncestorJoin_ensures(after, x, t, k);
        issueAncestorJoin_ensures(after, x, k, t);
        assert issueAncestorAt(after, child, k) == child;
        issueLinkChildFree_ensures(items, after, child, parent, root, k);
        assert false;
      }
    }
  }
'''),
    ('lemma issueAddAcyclic_ensures(items: seq<IssueRecord>, after: seq<IssueRecord>)',
     '''  var n := after[0].number;
  var q := after[0].parent;
  assert forall i :: 0 <= i < |items| ==> items[i].number != n && items[i].parent != n;
  assert q != n;
  issueAncestorAt_ensures(after, n, 0);
  issueAncestorAt_ensures(after, n, 1);
  assert issueAncestorAt(after, n, 0) == n;
  assert issueAncestorAt(after, n, 1) == q;
  forall i, k | 0 <= i < |after| && k >= 1
    ensures issueAncestorAt(after, after[i].number, k) != after[i].number
  {
    if i == 0 {
      issueAncestorJoin_ensures(after, n, 1, k - 1);
      forall t | 0 <= t < k - 1
        ensures issueAncestorAt(items, q, t) != n
      {
        issueAvoids_ensures(items, q, n, t);
      }
      issueAddFrame_ensures(items, after, q, k - 1);
      issueAvoids_ensures(items, q, n, k - 1);
    } else {
      var x := after[i].number;
      assert after[i] == items[i - 1];
      forall t | 0 <= t < k
        ensures issueAncestorAt(items, x, t) != n
      {
        issueAvoids_ensures(items, x, n, t);
      }
      issueAddFrame_ensures(items, after, x, k);
    }
  }
'''),
    ('lemma issuesAfter_ensures(items: seq<IssueRecord>, created: IssueRecord, edit: IssueEdit)',
     '''  var after := issuesAfter(items, created, edit);
  if issueCreates(edit.op) {
    assert |after| == |items| + 1 && after[0].number == created.number && after[0].parent == (if edit.op.split? then edit.number else 0);
    assert forall i :: 0 <= i < |items| ==> after[i + 1] == items[i];
  } else {
    assert |after| == |items|;
    assert forall i :: 0 <= i < |items| ==> after[i].number == items[i].number && after[i].parent == (if items[i].number == edit.number && edit.op.link? then edit.parent else items[i].parent);
  }
  if !((forall i: int :: ((0 <= i) ==> (i < |items|) ==> (items[i].number > 0))) && (forall i: int :: ((0 <= i) ==> (i < |items|) ==> ((items[i].parent == 0) || exists j: int :: (((0 <= j) && (j < |items|)) && (items[j].number == items[i].parent))))) && (forall i: int, k: int :: ((0 <= i) ==> (i < |items|) ==> (k >= 1) ==> (issueAncestorAt(items, items[i].number, k) != items[i].number))) && (!(issueCreates(edit.op)) || ((created.number > 0) && forall i: int :: ((0 <= i) ==> (i < |items|) ==> (items[i].number < created.number)))) && ((!edit.op.split?) || exists j: int :: (((0 <= j) && (j < |items|)) && (items[j].number == edit.number))) && ((!edit.op.link?) || (((((edit.number > 0) && (edit.parent > 0)) && (edit.number != edit.parent)) && exists i: int :: (((0 <= i) && (i < |items|)) && (items[i].number == edit.number))) && exists k: int :: ((((0 <= k) && (k <= (|items| + 1))) && (issueAncestorAt(items, edit.parent, k) == 0)) && forall t: int :: ((0 <= t) ==> (t < k) ==> (issueAncestorAt(items, edit.parent, t) != edit.number)))))) {
    return;
  }
  if issueCreates(edit.op) {
    issueAddAcyclic_ensures(items, after);
    forall i | 0 <= i < |after|
      ensures after[i].number > 0
      ensures after[i].parent == 0 || exists j :: 0 <= j < |after| && after[j].number == after[i].parent
    {
      if i == 0 {
        if edit.op.split? {
          var j :| 0 <= j < |items| && items[j].number == edit.number;
          assert after[j + 1] == items[j];
        }
      } else {
        assert after[i] == items[i - 1];
        if items[i - 1].parent != 0 {
          var j :| 0 <= j < |items| && items[j].number == items[i - 1].parent;
          assert after[j + 1] == items[j];
        }
      }
    }
  } else if edit.op.link? {
    var root :| (((0 <= root) && (root <= (|items| + 1))) && (issueAncestorAt(items, edit.parent, root) == 0)) && forall t: int :: ((0 <= t) ==> (t < root) ==> (issueAncestorAt(items, edit.parent, t) != edit.number));
    issueLinkAcyclic_ensures(items, after, edit.number, edit.parent, root);
    issueRootedExists_ensures(items, edit.parent, root);
    var p :| 0 <= p < |items| && items[p].number == edit.parent;
    forall i | 0 <= i < |after|
      ensures after[i].parent == 0 || exists j :: 0 <= j < |after| && after[j].number == after[i].parent
    {
      if items[i].number == edit.number {
        assert after[p].number == edit.parent;
      } else if items[i].parent != 0 {
        var j :| 0 <= j < |items| && items[j].number == items[i].parent;
        assert after[j].number == items[j].number;
      }
    }
  } else {
    forall s, k | k >= 0
      ensures issueAncestorAt(after, s, k) == issueAncestorAt(items, s, k)
    {
      issueSameEdges_ensures(items, after, s, k);
    }
    forall i | 0 <= i < |after|
      ensures after[i].parent == 0 || exists j :: 0 <= j < |after| && after[j].number == after[i].parent
    {
      if items[i].parent != 0 {
        var j :| 0 <= j < |items| && items[j].number == items[i].parent;
        assert after[j].number == items[j].number;
      }
    }
  }
'''),
]

# Replaying the history's journal reproduces the live history (0018, fifth proofs lane).
REPLAY_HISTORY_STEPS = [
    ('lemma replayedHistoryPrefix_ensures(initial: History, journal: seq<Event>, next: seq<Event>, count: int)',
     '  if count > 0 {\n    replayedHistoryPrefix_ensures(initial, journal, next, count - 1);\n  }\n'),
    ('lemma liveHistoryReplays_ensures(initial: History, journal: seq<Event>, history: History, intent: Intent, next: seq<Event>)',
     '''  var recorded := recordedHistory(history, intent);
  if recorded.decision.true_? {
    replayedHistoryPrefix_ensures(initial, journal, next, |journal|);
    assert replayedHistory(initial, next, |next|) == replayStep(replayedHistory(initial, next, |journal|), next[|journal|]);
  }
'''),
]

# Replaying a conversation's log reproduces the live conversation (0018, fifth proofs lane).
REPLAY_CONVERSATION_STEPS = [
    ('lemma replayedLogPrefix_ensures(initial: Conversation, log: seq<Event>, next: seq<Event>, count: int)',
     '  if count > 0 {\n    replayedLogPrefix_ensures(initial, log, next, count - 1);\n  }\n'),
    ('lemma recordedConversation_ensures(initial: Conversation, conversation: Conversation, log: seq<Event>, intent: Intent)',
     '''  var recorded := recordedConversation(initial, conversation, log, intent);
  if recorded.decision.true_? && conversation == replayedLog(initial, log, |log|) {
    replayedLogPrefix_ensures(initial, log, recorded.log, |log|);
    assert replayedLog(initial, recorded.log, |recorded.log|) == conversationStep(replayedLog(initial, recorded.log, |log|), recorded.log[|log|]);
  }
'''),
]

LEMMA_STEPS = {
    'src/history/seedInputDecision.vibe': [
        ('lemma batchRevset_ensures(ids: seq<string>, start: int, end: int)',
         '  var selected := SafeSlice(ids, start, end);\n  var mapped := seq(|selected|, i requires 0 <= i < |selected| => "present(" + selected[i] + ")");\n  assert selected == ids[start..end];\n  assert |mapped| == end - start;\n  var actual := (var s_map := SafeSlice(ids, start, end); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var id := s_map[i_map]; (("present(" + id) + ")")));\n  assert forall i :: 0 <= i < |mapped| ==> mapped[i] == actual[i];\n  assert mapped == actual;\n  assert batchRevset(ids, start, end) == SeqJoin(actual, "|");\n  var cursor := end;\n  while cursor > start\n    invariant start <= cursor <= end\n    invariant batchRevset(ids, start, end) == SeqJoin(mapped, "|")\n    invariant SeqJoin(mapped[cursor - start..], "|") == referenceList(ids, cursor, end)\n    decreases cursor - start\n  {\n    var before := cursor - 1;\n    assert mapped[before - start..][1..] == mapped[cursor - start..];\n    assert mapped[before - start] == "present(" + ids[before] + ")";\n    cursor := before;\n  }\n'),
        ('lemma knownTitles_ensures(ids: seq<string>, titles: map<string, string>)',
         '  if |ids| > 0 {\n    knownTitles_ensures(ids[1..], titles);\n    var chunks := seq(|ids|, i requires 0 <= i < |ids| => if ids[i] in titles then [titles[ids[i]]] else []);\n    var tail := seq(|ids[1..]|, i requires 0 <= i < |ids[1..]| => if ids[1..][i] in titles then [titles[ids[1..][i]]] else []);\n    assert chunks[1..] == tail;\n    var actual := seq(|ids|, i_map requires 0 <= i_map < |ids| => var id := ids[i_map]; (if id in titles then [titles[id]] else []));\n    assert forall i :: 0 <= i < |chunks| ==> chunks[i] == actual[i];\n    assert chunks == actual;\n    assert knownTitles(ids, titles) == SeqFlatten(actual);\n    var actualTail := seq(|ids[1..]|, i_map requires 0 <= i_map < |ids[1..]| => var id := ids[1..][i_map]; (if id in titles then [titles[id]] else []));\n    assert forall i :: 0 <= i < |tail| ==> tail[i] == actualTail[i];\n    assert tail == actualTail;\n    assert knownTitles(ids[1..], titles) == SeqFlatten(actualTail);\n    assert SeqFlatten(chunks) == chunks[0] + SeqFlatten(chunks[1..]);\n    assert SafeSlice(ids, 1, |ids|) == ids[1..];\n  }\n'),
    ],
    'src/core/conversation.vibe': [
        ('lemma pendingCount_ensures(pending: seq<Pending>, clientId: string, end: int)', PENDING_COUNT_STEPS),
    ],
    'src/core/sequencerDecision.vibe': [
        ('lemma restartsBefore_ensures(log: seq<Event>, reply: string, end: int)',
         '  if end > 0 {\n    restartsBefore_ensures(log, reply, end - 1);\n  }\n'),
    ],
    'src/history/seedDecision.vibe': [
        ('lemma lastFitEnd_ensures(ends: seq<int>, max: int, end: int)',
         '  if end > 0 {\n    lastFitEnd_ensures(ends, max, end - 1);\n  }\n'),
        ('lemma sentenceCut_ensures(ends: seq<int>, length: int, max: int, maxNote: int)',
         '  lastFitEnd_ensures(ends, max, |ends|);\n'),
    ],
    'src/core/issueGraphDecision.vibe': ISSUE_GRAPH_STEPS,
    'src/history/replayDecision.vibe': REPLAY_HISTORY_STEPS,
    'src/core/replayDecision.vibe': REPLAY_CONVERSATION_STEPS,
    'src/core/mockFactoryDecision.vibe': [
        # Keys of different kinds end in different units ("t" of agent, "n" of person); keys of one kind and one
        # length share their id prefix.
        ('lemma actorKey_ensures(id: string, agent: bool)',
         '  forall other: string\n'
         '    ensures actorKey(id, agent) != other + "/" + actorKind(!agent)\n'
         '  {\n'
         '    var a := id + "/" + actorKind(agent);\n'
         '    var b := other + "/" + actorKind(!agent);\n'
         '    if a == b {\n'
         '      assert a[|a| - 1] == actorKind(agent)[|actorKind(agent)| - 1];\n'
         '      assert b[|b| - 1] == actorKind(!agent)[|actorKind(!agent)| - 1];\n'
         '    }\n'
         '  }\n'
         '  forall other: string | other != id\n'
         '    ensures actorKey(id, agent) != other + "/" + actorKind(agent)\n'
         '  {\n'
         '    var a := id + "/" + actorKind(agent);\n'
         '    var b := other + "/" + actorKind(agent);\n'
         '    if a == b {\n'
         '      assert |id| == |other|;\n'
         '      assert a[..|id|] == id;\n'
         '      assert b[..|other|] == other;\n'
         '    }\n'
         '  }\n'),
    ],
    'src/core/sandboxDecision.vibe': [
        ('lemma runningCountPrefix_ensures(sandboxes: seq<SandboxEntry>, end: int)',
         '  if end > 0 {\n    runningCountPrefix_ensures(sandboxes, end - 1);\n  }\n'),
    ],
}


def insertion_names(source):
    return [signature.split('(')[0].replace('lemma ', '') for signature, _ in LEMMA_STEPS.get(source, [])]


def add_proof_steps(generated, source):
    for signature, steps in LEMMA_STEPS.get(source, []):
        pattern = r'^' + re.escape(signature) + r'\n(?:[ \t]+(?:requires|ensures)[^\n]*\n)*\{\n(?P<body>.*?)^\}'
        matches = list(re.finditer(pattern, generated, re.MULTILINE | re.DOTALL))
        # lsc writes only `reveal f();` lines for `//@ opaque` and `//@ reveal`; steps go after them.
        if len(matches) != 1 or not REVEALS_ONLY.fullmatch(matches[0].group('body')):
            raise ValueError('Expected one fresh empty lemma: ' + signature)
        at = matches[0].end('body')
        generated = generated[:at] + steps + generated[at:]
    return generated
