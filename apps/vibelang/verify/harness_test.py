"""Regression: an ignored-only proof directory must never pass with zero checked sources."""
import json, os, pathlib, subprocess, sys, tempfile, unittest
from sources import production_sources
HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(__file__).resolve().parent

class StrictSourceChecks(unittest.TestCase):
    def test_a_lemmascript_source_newer_than_its_build_is_stale(self):
        import os, time
        from lsc_fresh import stale
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            package = pathlib.Path(folder)
            (package / 'tools/src').mkdir(parents=True)
            (package / 'tools/dist').mkdir()
            source = package / 'tools/src/emit.ts'
            source.write_text('export {}\n')
            self.assertTrue(stale(package))
            built = package / 'tools/dist/lsc.js'
            built.write_text('')
            past = time.time() - 60
            os.utime(source, (past, past))
            self.assertFalse(stale(package))
            os.utime(source, None)
            self.assertTrue(stale(package))

    def test_a_function_named_by_a_dafny_keyword_is_verified_under_its_escaped_name(self):
        from sources import dafny_keywords, dafny_name
        keywords = dafny_keywords()
        self.assertTrue({'fresh', 'match', 'seq'} <= keywords)
        self.assertNotIn('this', keywords)
        self.assertEqual([dafny_name(n, keywords) for n in ['fresh', '_x', 'plain']], ['fresh_', 'i_x', 'plain'])
        import os
        # A positive check: never the mutation manifest broken.py exports to its own children.
        env = {k: v for k, v in os.environ.items() if k != 'VERIFY_MUTATION_MANIFEST'}
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            source = pathlib.Path(folder) / 'keyword.ts'
            source.write_text('//@ verify\n//@ ensures \\result == (seq > cut)\nexport function fresh(seq: number, cut: number): boolean {\n  return seq > cut\n}\n')
            result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(source)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn('was not emitted', result.stdout)
            source.write_text('//@ verify\n//@ ensures \\result == (seq > cut)\nexport function fresh(seq: number, cut: number): boolean {\n  return seq >= cut\n}\n')
            result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(source)], capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('function fresh', result.stdout)

    def test_valid_whitespace_cannot_hide_a_module(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            app = pathlib.Path(folder)
            (app / 'src').mkdir()
            for index, directive in enumerate(['//@ verify', '  //@ verify', '//@ verify ', '\t//@ verify\t']):
                (app / 'src' / f'module{index}.vibe').write_text(directive + '\nexport function yes() { return true }\n')
            (app / 'src' / 'unmarked.vibe').write_text('export function yes() { return true }\n')
            self.assertEqual(len(production_sources(app)), 4)

    def test_empty_selection_is_not_success(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            nested = pathlib.Path(folder) / '.checks'
            nested.mkdir()
            (nested / 'invalid.ts').write_text('export const wrong: number = "not a number"\n')
            result = subprocess.run(['node', str(ROOT / 'typecheck.cjs'), folder], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_explicit_nested_source_is_checked(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            nested = pathlib.Path(folder) / '.checks'
            nested.mkdir()
            source = nested / 'invalid.ts'
            source.write_text('export const wrong: number = "not a number"\n')
            result = subprocess.run(['node', str(ROOT / 'typecheck.cjs'), str(source)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('TS2322', result.stderr)

class SourceArguments(unittest.TestCase):
    def test_extra_missing_source_is_not_ignored(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            source = pathlib.Path(folder) / 'valid.ts'
            source.write_text('//@ verify\n//@ ensures \\result == input\nexport function same(input: number): number { return input }\n')
            missing = pathlib.Path(folder) / 'missing.ts'
            result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(source), str(missing)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('Not found:', result.stdout + result.stderr)

class GenericFunctions(unittest.TestCase):
    def test_a_marked_generic_function_is_found_and_proved(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            source = pathlib.Path(folder) / 'generic.ts'
            source.write_text('//@ verify\n//@ ensures \\result.length == items.length + 1\nexport function added<C>(items: ReadonlyArray<C>, item: C): ReadonlyArray<C> { return [...items, item] }\n')
            env = {key: value for key, value in os.environ.items() if key not in ('VIBELANG_VERIFY_ROOT', 'VERIFY_MUTATION_MANIFEST')}
            result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(source)], capture_output=True, text=True, env=env)
            self.assertNotIn('was not emitted', result.stdout + result.stderr)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

class MutationLocation(unittest.TestCase):
    def test_contract_text_is_not_an_executable_match(self):
        from mutation_edit import executable_matches
        source='  return x > 0\n}\n//@ ensures \\result == (x > 0)\n'
        self.assertEqual(executable_matches(source, 'x > 0'), [source.index('x > 0')])

    def test_multiple_executable_matches_remain_ambiguous(self):
        from mutation_edit import executable_matches
        source='return x > 0 ? x > 0 : false'
        self.assertEqual(len(executable_matches(source, 'x > 0')), 2)

class TargetedPostconditions(unittest.TestCase):
    def test_selection_is_confined_to_the_named_function(self):
        from mutation_targets import postcondition_line
        generated='method other()\n ensures valid\n{\n}\nmethod target()\n ensures valid\n{\n}\n'
        self.assertEqual(postcondition_line(generated, 'target', 'valid'), 6)

    def test_missing_or_ambiguous_selection_fails_closed(self):
        from mutation_targets import postcondition_line
        for text in ['method target()\n{\n}', 'method target()\n ensures valid\n ensures valid\n{\n}']:
            with self.assertRaises(ValueError): postcondition_line(text, 'target', 'valid')

class TargetedAssertions(unittest.TestCase):
    def test_assertions_are_selected_inside_the_named_function_and_case(self):
        from mutation_targets import case_assertion_line
        source = 'method target()\n{\n  match event {\n    case Delta() =>\n      assert valid;\n    case Restart() =>\n      assert valid;\n  }\n}\nmethod other()\n{\n  assert valid;\n}\n'
        self.assertEqual(case_assertion_line(source, 'target', 'Delta', 'valid'), 5)
        self.assertEqual(case_assertion_line(source, 'target', 'Restart', 'valid'), 7)
        for function, case, clause in [('missing', 'Delta', 'valid'), ('target', 'missing', 'valid'), ('target', 'Delta', 'different')]:
            with self.assertRaises(ValueError): case_assertion_line(source, function, case, clause)
        ambiguous = source.replace('      assert valid;', '      assert valid;\n      assert valid;', 1)
        with self.assertRaises(ValueError): case_assertion_line(ambiguous, 'target', 'Delta', 'valid')

class FunctionAssertions(unittest.TestCase):
    def test_unguarded_assertion_is_confined_to_one_function(self):
        from mutation_targets import case_assertion_line
        source = 'method target()\n{\n  assert kept;\n}\nmethod other()\n{\n  assert kept;\n}\n'
        self.assertEqual(case_assertion_line(source, 'target', None, 'kept'), 3)
        with self.assertRaises(ValueError): case_assertion_line(source, 'missing', None, 'kept')
        with self.assertRaises(ValueError): case_assertion_line(source, 'target', None, 'missing')
        with self.assertRaises(ValueError): case_assertion_line(source.replace('  assert kept;', '  assert kept;\n  assert kept;', 1), 'target', None, 'kept')

class CheckedProofAdditions(unittest.TestCase):
    def test_induction_only_adds_checked_steps_to_the_named_empty_lemma(self):
        from proof_additions import add_proof_steps, PENDING_COUNT_STEPS
        source = 'function f(): int { 0 }\nlemma pendingCount_ensures(pending: seq<Pending>, clientId: string, end: int)\n  requires 0 <= end\n  ensures valid\n{\n}\n'
        result = add_proof_steps(source, 'src/core/conversation.vibe')
        self.assertEqual(result.replace(PENDING_COUNT_STEPS, '', 1), source)
        self.assertEqual(result.count(PENDING_COUNT_STEPS), 1)
        self.assertEqual(add_proof_steps(source, 'src/other.vibe'), source)
        for invalid in [source.replace('pendingCount_ensures', 'other'), source+source, source.replace('{\n}', '{\n  assert valid;\n}')]:
            with self.assertRaises(ValueError): add_proof_steps(invalid, 'src/core/conversation.vibe')

    def test_sandbox_induction_only_adds_a_step_to_the_specification_measure(self):
        from proof_additions import add_proof_steps, LEMMA_STEPS, insertion_names
        signature, steps = LEMMA_STEPS['src/core/sandboxDecision.vibe'][0]
        source = signature + '\n  requires 0 <= end\n  ensures valid\n{\n}\n'
        result = add_proof_steps(source, 'src/core/sandboxDecision.vibe')
        self.assertEqual(result.replace(steps, '', 1), source)
        self.assertEqual(result.count(steps), 1)
        self.assertEqual(insertion_names('src/core/sandboxDecision.vibe'), ['runningCountPrefix_ensures'])
        for invalid in [source + source, source.replace('{\n}', '{\n  assert valid;\n}')]:
            with self.assertRaises(ValueError): add_proof_steps(invalid, 'src/core/sandboxDecision.vibe')

class MutationModuleFilter(unittest.TestCase):
    def run_mutations(self, *args):
        with tempfile.TemporaryDirectory() as out:
            proc = subprocess.run([sys.executable, str(HERE / 'mutations.py'), out, *args], text=True, capture_output=True)
            manifest = json.loads((pathlib.Path(out) / 'manifest.json').read_text()) if proc.returncode == 0 else {}
            return proc, manifest

    def test_module_option_selects_only_that_modules_mutations(self):
        proc, manifest = self.run_mutations('--module', 'src/web/tourDecision.vibe')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(manifest)
        self.assertEqual({item['source'] for item in manifest.values()}, {'src/web/tourDecision.vibe'})

    def test_module_with_no_mutations_fails_closed(self):
        proc, _ = self.run_mutations('--module', 'src/web/absent.vibe')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('No mutations in', proc.stderr)


class MutationContractFailures(unittest.TestCase):
    def test_a_broken_capacity_guard_fails_the_callee_domain_contract(self):
        from mutation_results import validate_rejection
        validate_rejection({'exit': 4, 'output': 'Error: a precondition for this call could not be proved',
                            'mapped': ['source.vibe:12: function decideWithinCapacity [decideWithinCapacity; generated line 679]']}, 'decideWithinCapacity')

    def test_invalid_union_destructor_cannot_hide_behind_a_postcondition_failure(self):
        from mutation_results import validate_rejection
        with self.assertRaises(ValueError):
            validate_rejection({'exit': 4,
                'output': "Error: destructor 'clientId' can only be applied to datatype values constructed by 'Posted'\nError: a postcondition could not be proved",
                'mapped': ['function receive [receive]']}, 'receive')

    def test_success_tool_failures_and_unrelated_functions_are_never_rejections(self):
        from mutation_results import validate_rejection
        for code, output, mapped in [
            (0, '0 errors', ['function wanted [wanted]']),
            (4, 'a postcondition could not be proved; timed out', ['function wanted [wanted]']),
            (4, 'a postcondition could not be proved; 2 resolution/type errors', ['function wanted [wanted]']),
            (4, 'a postcondition could not be proved', ['function other [other]']),
        ]:
            with self.assertRaises(ValueError): validate_rejection({'exit': code, 'output': output, 'mapped': mapped}, 'wanted')

if __name__ == '__main__':
    (ROOT / '.checks').mkdir(exist_ok=True)
    unittest.main()
