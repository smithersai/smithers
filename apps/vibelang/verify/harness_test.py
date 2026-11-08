"""Regression: an ignored-only proof directory must never pass with zero checked sources."""
import pathlib, subprocess, sys, tempfile, unittest
from sources import production_sources
ROOT = pathlib.Path(__file__).resolve().parent

class StrictSourceChecks(unittest.TestCase):
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

class MutationContractFailures(unittest.TestCase):
    def test_a_broken_capacity_guard_fails_the_callee_domain_contract(self):
        from mutation_results import validate_rejection
        validate_rejection({'exit': 4, 'output': 'Error: a precondition for this call could not be proved',
                            'mapped': ['source.vibe:12: function decideWithinCapacity [decideWithinCapacity; generated line 679]']}, 'decideWithinCapacity')

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
