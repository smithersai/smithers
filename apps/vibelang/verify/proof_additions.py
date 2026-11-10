"""Checked Dafny proof steps, inserted into fresh empty lemmas.

Never saved generated artifacts: insertion only, so every generated declaration, precondition, postcondition and
body stays byte-identical. Recursive helpers lower as spec-callable Dafny functions whose postconditions live on
fresh empty `_ensures` lemmas; the inductive steps below are how the backend discharges them (pendingCount
precedent). Sandbox runtime traversals stay iterative; exact guard clauses use quantified source positions rather than
calling loop-backed methods inside expressions (the documented method-spec tool boundary).
"""
import re

PENDING_COUNT_STEPS = '  if end > 0 {\n    pendingCount_ensures(pending, clientId, end - 1);\n  }\n'

LEMMA_STEPS = {
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
        if len(matches) != 1 or matches[0].group('body').strip():
            raise ValueError('Expected one fresh empty lemma: ' + signature)
        at = matches[0].start('body')
        generated = generated[:at] + steps + generated[at:]
    return generated
