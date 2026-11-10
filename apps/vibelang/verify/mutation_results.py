"""Only a direct own-contract error in the mutated function counts as rejection."""
import pathlib
import re

OWN_KINDS={'postcondition','invariant','assertion'}
TOOL_ERROR=r'(resolution/type errors|timed out|time out|ERROR:|unresolved identifier|destructor .* can only be applied|resource limit|inconclusive|prover exception|out of memory)'

def validate_rejection(result,function):
    if result['exit']!=4:
        raise ValueError('not a Dafny contract failure')
    if re.search(TOOL_ERROR,result['output']):
        raise ValueError('tool error or timeout')
    target=result.get('dfy')
    if target is None:
        raise ValueError('missing generated target')
    target=pathlib.Path(target).resolve()
    if not any(d['severity']=='error' and d['kind'] in OWN_KINDS
               and d['function']==function and pathlib.Path(d['file']).resolve()==target
               for d in result.get('diagnostics',[])):
        raise ValueError('no direct own-contract failure in the mutated function')
