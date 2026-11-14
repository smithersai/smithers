"""Native adapter mutants: executable regressions, never counted as formal proofs.
`python3 verify/runtime_mutations.py --check` lists every case whose text no longer matches its source exactly once
(the landing check refuses each; runtime_broken.py would stop on it)."""
import pathlib, sys
CASES = [
    ('runtime-budget-lock', 'worker/Budget.vibe', 'test/budget.coverage.test.vibe',
     'return try Semaphore.withPermits(lock, 1)(effect {', 'return try (effect {',
     'twenty concurrent admissions'),
    ('runtime-usage-zero', 'worker/CallBudget.vibe', 'test/callBudget.test.vibe',
     'const usable = usableCall(settled, Budget.reportsTokens(usage))', 'const usable = usableCall(settled, true)',
     'missing usage'),
    ('runtime-meter-clock', 'src/core/sandboxMeter.vibe', 'test/sandboxMeter.test.vibe',
     'meterStep(used, count, cursor, end, month, boundary, prior)',
     'meterStep(used, count, cursor, cursor, month, boundary, prior)',
     'keeps both sides of a UTC boundary'),
]


def stale(app):
    """Each case whose original text its source holds other than exactly once."""
    lines = []
    for name, source, _test, old, _new, _expected in CASES:
        found = (app / source).read_text().count(old)
        if found != 1:
            lines.append(f'{name}: {source} holds its text {found} times, not once')
    return lines


if __name__ == '__main__' and sys.argv[1:] == ['--check']:
    found = stale(pathlib.Path(__file__).resolve().parent.parent)
    for line in found:
        print(line)
    sys.exit(1 if found else 0)
