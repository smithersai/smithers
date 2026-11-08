"""Production postconditions selected for expensive negative cases; positive proofs still check every obligation."""
POSTCONDITIONS = {
    'apply-pane': '(res.pane == event.url)',
    'apply-pane-guard': '(res.pane != conversation.pane)',
    'apply-phase': '(res.agent.working? == (res.replying != ""))',
    'apply-tour-end-text': 'event.TourEnded?',
    'apply-tour-busy': '(res.entries[i].id == res.replying)',
}

def postcondition_line(generated, function, contains):
    import re
    lines=generated.splitlines()
    start=next((i for i,line in enumerate(lines) if re.match(r'(?:ghost )?(?:method|function) '+re.escape(function)+r'\(',line)),None)
    if start is None: raise ValueError('Missing target function '+function)
    end=next((i for i in range(start+1,len(lines)) if lines[i]=='{'),len(lines))
    matches=[i+1 for i in range(start,end) if lines[i].lstrip().startswith('ensures ') and contains in lines[i]]
    if len(matches)!=1: raise ValueError(f'Expected one production postcondition, got {len(matches)}: {contains}')
    return matches[0]
