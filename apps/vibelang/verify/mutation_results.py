"""Only real Dafny contract failures in the mutated function count as rejections.

A failed precondition at a call is the callee's domain, not a property of the mutated function's own result: it
counts only for a mutation whose stated claim is that call (`CALLEE_PRECONDITIONS` in mutation_targets.py)."""
import re

OWN = r'(postcondition could not be proved|(?:loop|this) invariant could not be proved|assertion might not hold)'
CALL = r'a precondition for this call could not be proved'

def validate_rejection(result, function, callee_precondition=False):
    phrase = f'(?:{OWN}|{CALL})' if callee_precondition else OWN
    if result['exit'] != 4 or not re.search(phrase, result['output']):
        raise ValueError('not a Dafny contract failure of the mutated function' if re.search(CALL, result['output']) else 'not a Dafny contract failure')
    if not any(f'function {function} [' in location for location in result['mapped']):
        raise ValueError('failure outside the mutated function')
    if re.search(r'(resolution/type errors|timed out|ERROR:|unresolved identifier|destructor .* can only be applied)', result['output']):
        raise ValueError('tool error or timeout')
