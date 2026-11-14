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


def unrejected(results,manifest):
    """Every mutation result that is not a rejection, as `INVALID name: ...` (the mutant does not typecheck) or
    `SURVIVED name: ...` (it typechecks and no own contract failed), in manifest order."""
    by_name={pathlib.Path(r['file']).stem:r for r in results}
    lines=[]
    for name,item in manifest.items():
        result=by_name.get(name)
        if result is None:
            lines.append(f"MISSING {name}: no result ({item['source']} {item['function']})"); continue
        if result.get('invalid'):
            lines.append(f"INVALID {name}: the mutant does not typecheck ({item['source']} {item['function']})"); continue
        try: validate_rejection(result,item['function'])
        except ValueError as error: lines.append(f"SURVIVED {name}: {error} ({item['source']} {item['function']})")
    return lines
