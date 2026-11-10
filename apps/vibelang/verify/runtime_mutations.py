"""Native adapter mutants: executable regressions, never counted as formal proofs."""
CASES = [
    ('runtime-budget-lock', 'worker/Budget.vibe', 'test/budget.coverage.test.vibe',
     'return try Semaphore.withPermits(lock, 1)(effect {', 'return try (effect {',
     'twenty concurrent admissions'),
    ('runtime-usage-zero', 'worker/CallBudget.vibe', 'test/callBudget.test.vibe',
     'const usable = settled && Budget.reportsTokens(usage)', 'const usable = settled',
     'missing usage'),
    ('runtime-meter-clock', 'src/core/sandboxMeter.vibe', 'test/sandboxMeter.test.vibe',
     'meterStep(used, count, cursor, end, month, boundary, prior)',
     'meterStep(used, count, cursor, cursor, month, boundary, prior)',
     'keeps both sides of a UTC boundary'),
]
