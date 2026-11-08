"""Checked Dafny proof steps, inserted into fresh empty lemmas; never saved generated artifacts."""
import re

PENDING_COUNT_STEPS = '  if end > 0 {\n    pendingCount_ensures(pending, clientId, end - 1);\n  }\n'

def add_proof_steps(generated, source):
    if source != 'src/core/conversation.vibe':
        return generated
    signature = 'lemma pendingCount_ensures(pending: seq<Pending>, clientId: string, end: int)'
    pattern = r'^'+re.escape(signature)+r'\n(?:[ \t]+(?:requires|ensures)[^\n]*\n)*\{\n(?P<body>.*?)^\}'
    matches = list(re.finditer(pattern, generated, re.MULTILINE | re.DOTALL))
    if len(matches) != 1 or matches[0].group('body').strip():
        raise ValueError('Expected one fresh empty pendingCount_ensures lemma')
    at = matches[0].start('body')
    # This is insertion only: every generated declaration, precondition, postcondition and body remains byte-identical.
    return generated[:at] + PENDING_COUNT_STEPS + generated[at:]
