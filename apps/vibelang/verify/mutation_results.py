"""Only real Dafny contract failures in the mutated function count as rejections."""
import re

def validate_rejection(result, function):
    if result['exit'] != 4 or not re.search(r'(a precondition for this call could not be proved|postcondition could not be proved|(?:loop|this) invariant could not be proved|assertion might not hold)', result['output']):
        raise ValueError('not a Dafny contract failure')
    if not any(f'function {function} [' in location for location in result['mapped']):
        raise ValueError('failure outside the mutated function')
    if re.search(r'(resolution/type errors|timed out|ERROR:|unresolved identifier)', result['output']):
        raise ValueError('tool error or timeout')
