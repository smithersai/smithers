"""Regression: an ignored-only proof directory must never pass with zero checked sources."""
import pathlib, subprocess, tempfile, unittest
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

if __name__ == '__main__':
    (ROOT / '.checks').mkdir(exist_ok=True)
    unittest.main()
