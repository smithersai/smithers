"""Regression: an ignored-only proof directory must never pass with zero checked sources."""
import json, os, pathlib, subprocess, sys, tempfile, unittest
from sources import production_sources
HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(__file__).resolve().parent

class StrictSourceChecks(unittest.TestCase):
    def test_a_lone_mutant_gets_its_imports_imports(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            out = pathlib.Path(folder)
            result = subprocess.run([sys.executable, str(ROOT / 'mutations.py'), str(out), 'page-count-end'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((out / 'stackDecision.vibe.ts').exists())
            self.assertTrue((out / 'mythical.vibe.ts').exists())

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

    def test_lsc_is_a_relative_link_that_survives_a_packed_tree(self):
        # A packed tree (run-heavy on a box) copies an absolute link's target as a file, and ts-morph then can't resolve.
        from lsc_fresh import link
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            root = pathlib.Path(folder)
            package, tools = root / 'packages/lemmascript', root / 'apps/vibelang/verify/.tools'
            (package / 'tools/dist').mkdir(parents=True)
            (package / 'tools/dist/lsc.js').write_text('built\n')
            (tools / 'bin').mkdir(parents=True)
            for stale in ['copy', 'absolute']:
                lsc = tools / 'bin/lsc'
                if lsc.is_symlink() or lsc.exists(): lsc.unlink()
                if stale == 'copy': lsc.write_text('built\n')
                else: lsc.symlink_to(package / 'tools/dist/lsc.js')
                link(tools, package)
                self.assertTrue(lsc.is_symlink(), stale)
                self.assertEqual(os.readlink(lsc), '../../../../../packages/lemmascript/tools/dist/lsc.js', stale)
                self.assertEqual(lsc.resolve(), (package / 'tools/dist/lsc.js').resolve(), stale)

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

class IsolatedCoreBudget(unittest.TestCase):
    def test_configured_invocation_obeys_core_cap(self):
        # Check the policy before launching a solver; a failing test must not itself launch more than two cores.
        import ast
        tree = ast.parse((ROOT / 'check.py').read_text())
        found = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != 'command': continue
            if not node.args or not isinstance(node.args[0], ast.List): continue
            args = node.args[0].elts
            for i, arg in enumerate(args[:-1]):
                if isinstance(arg, ast.Constant) and arg.value == '--cores':
                    value = args[i + 1]
                    choices = [value.body, value.orelse] if isinstance(value, ast.IfExp) else [value]
                    found.extend(int(ast.literal_eval(choice)) for choice in choices)
        self.assertTrue(found, 'No bounded Dafny invocation found')
        self.assertTrue(all(1 <= n <= 2 for n in found), found)

    def test_isolated_production_proofs_use_at_most_two_cores(self):
        # Exercise the real production-path selection and inspect the actual Dafny invocation receipt.
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            app = pathlib.Path(folder)
            (app / 'src/core').mkdir(parents=True)
            (app / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json')}))
            (app / 'src/core/decide.vibe').write_text('//@ verify\n//@ ensures \\result == input\nexport function same(input: number): number { return input }\n')
            env = {k: v for k, v in os.environ.items() if k != 'VERIFY_MUTATION_MANIFEST'}
            env['VIBELANG_VERIFY_ROOT'] = str(app)
            result = subprocess.run([sys.executable, str(ROOT / 'check.py')], capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summaries = list((app / 'verify/.checks').glob('run-*/summary.json'))
            self.assertEqual(len(summaries), 1)
            calls = [c['argv'] for c in json.loads(summaries[0].read_text())['commands'] if pathlib.Path(c['argv'][0]).name == 'dafny']
            self.assertEqual(len(calls), 1)
            self.assertIn('--isolate-assertions', calls[0])
            self.assertLessEqual(int(calls[0][calls[0].index('--cores') + 1]), 2)


    def test_a_sequential_isolated_dependency_gets_two_cores(self):
        # A mutation run proves its dependencies one at a time before the mutants. With CHECK_JOBS=2 an isolated
        # dependency (conversation.vibe) got one core and hit the 7,200 s wall on a box (job vl-proveall:full48).
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            app = pathlib.Path(folder)
            (app / 'src/core').mkdir(parents=True)
            (app / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json'), 'files': [], 'include': []}))
            (app / 'src/core/decide.vibe').write_text('//@ verify\n//@ ensures \\result == input\nexport function same(input: number): number { return input }\n')
            (app / 'src/core/caller.vibe').write_text('import { same } from "./decide.vibe"\n//@ verify\n//@ ensures \\result == input\nexport function call(input: number): number { return same(input) }\n')
            mutants = app / 'mutants'; mutants.mkdir()
            (mutants / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json'), 'files': [], 'include': []}))
            (mutants / 'decide.vibe.ts').write_text((app / 'src/core/decide.vibe').read_text())
            (mutants / 'call-wrong.ts').write_text('import { same } from "./decide.vibe"\n//@ verify\n//@ ensures \\result == input\nexport function call(input: number): number { return same(input) + 1 }\n')
            (mutants / 'manifest.json').write_text(json.dumps({'call-wrong': {'source': 'src/core/caller.vibe', 'function': 'call'}}))
            env = {k: v for k, v in os.environ.items() if k != 'VERIFY_FRESH'}
            env.update(VIBELANG_VERIFY_ROOT=str(app), CHECK_JOBS='2', VERIFY_MUTATION_MANIFEST=str(mutants / 'manifest.json'))
            result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(mutants)], capture_output=True, text=True, env=env, timeout=300)
            summaries = list((app / 'verify/.checks').glob('run-*/summary.json'))
            self.assertEqual(len(summaries), 1, result.stdout + result.stderr)
            calls = {pathlib.Path(c['argv'][-1]).stem: c['argv'] for c in json.loads(summaries[0].read_text())['commands'] if pathlib.Path(c['argv'][0]).name == 'dafny'}
            self.assertEqual(calls['decide'][calls['decide'].index('--cores') + 1], '2', result.stdout)
            self.assertEqual(calls['call-wrong'][calls['call-wrong'].index('--cores') + 1], '1', result.stdout)


class PositiveProofTimeLimits(unittest.TestCase):
    def test_history_headroom_does_not_change_mutant_or_other_module_limits(self):
        from mutation_targets import time_limit
        self.assertEqual(time_limit('replayDecision', False, 'src/history/replayDecision.vibe'), 180)
        self.assertEqual(time_limit('replayDecision', False, 'src/core/replayDecision.vibe'), 60)
        self.assertEqual(time_limit('replay-order', True, 'src/history/replayDecision.vibe'), 120)
        self.assertEqual(time_limit('history-live-stale', True, 'src/history/replayDecision.vibe'), 30)

    def test_conversation_headroom_is_positive_only(self):
        # One receive obligation of 14,905 timed out at 60 s inside a loaded mutation box (2026-11-10).
        from mutation_targets import time_limit
        self.assertEqual(time_limit('conversation', False, 'src/core/conversation.vibe'), 120)
        self.assertEqual(time_limit('apply-advance', True, 'src/core/conversation.vibe'), 30)

    def test_real_invocation_selects_the_positive_budget_by_module_path(self):
        for module, limit in [('src/history/replayDecision.vibe', 180), ('src/core/replayDecision.vibe', 60)]:
            with self.subTest(module=module), tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
                app = pathlib.Path(folder)
                source = app / module
                source.parent.mkdir(parents=True)
                (app / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json')}))
                source.write_text('//@ verify\n//@ ensures \\result == input\nexport function same(input: number): number { return input }\n')
                env = {k: v for k, v in os.environ.items() if k != 'VERIFY_MUTATION_MANIFEST'}
                env['VIBELANG_VERIFY_ROOT'] = str(app)
                result = subprocess.run([sys.executable, str(ROOT / 'check.py')], capture_output=True, text=True, env=env, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                summaries = list((app / 'verify/.checks').glob('run-*/summary.json'))
                self.assertEqual(len(summaries), 1)
                calls = [c['argv'] for c in json.loads(summaries[0].read_text())['commands'] if pathlib.Path(c['argv'][0]).name == 'dafny']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][calls[0].index('--verification-time-limit') + 1], str(limit))
                source.write_text('//@ verify\n//@ ensures \\result == input\nexport function same(input: number): number { return input + 1 }\n')
                wrong = subprocess.run([sys.executable, str(ROOT / 'check.py')], capture_output=True, text=True, env=env, timeout=120)
                self.assertNotEqual(wrong.returncode, 0, wrong.stdout + wrong.stderr)
                self.assertIn('a postcondition could not be proved', wrong.stdout)

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
    def test_a_generic_function_is_found_and_ends_at_the_next_generic_function(self):
        from mutation_edit import function_span
        source = 'export function a<R extends X>(xs: R[]): number {\n  return 1\n}\nexport function b<R extends X>(xs: R[]): number {\n  return 2\n}\n'
        start, end = function_span(source, 'a')
        self.assertEqual(source[start:end], 'export function a<R extends X>(xs: R[]): number {\n  return 1\n}\n')
        start, end = function_span(source, 'b')
        self.assertIn('return 2', source[start:end])
        self.assertIsNone(function_span(source, 'c'))

    def test_a_spec_function_is_found_and_ends_at_the_next_function(self):
        from mutation_edit import function_span
        source = 'spec function a(n: number): number {\n  return n\n}\nexport function b(n: number): number {\n  return a(n)\n}\n'
        start, end = function_span(source, 'a')
        self.assertEqual(source[start:end], 'spec function a(n: number): number {\n  return n\n}\n')

    def test_a_parent_folder_import_is_copied_beside_the_mutant(self):
        from mutation_edit import flatten_imports
        folder = ROOT.parent / 'src/web'
        text, deps = flatten_imports('import { a } from "../core/conversation.vibe"\nimport { b } from "./x.vibe"\n', folder)
        self.assertEqual(text, 'import { a } from "./conversation.vibe"\nimport { b } from "./x.vibe"\n')
        self.assertEqual(deps['conversation.vibe'], (ROOT.parent / 'src/core/conversation.vibe').resolve())
        with self.assertRaises(SystemExit):
            flatten_imports('import { a } from "../core/x.vibe"\nimport { b } from "./x.vibe"\n', folder)

    def test_contract_text_is_not_an_executable_match(self):
        from mutation_edit import executable_matches
        source='  return x > 0\n}\n//@ ensures \\result == (x > 0)\n'
        self.assertEqual(executable_matches(source, 'x > 0'), [source.index('x > 0')])

    def test_multiple_executable_matches_remain_ambiguous(self):
        from mutation_edit import executable_matches
        source='return x > 0 ? x > 0 : false'
        self.assertEqual(len(executable_matches(source, 'x > 0')), 2)

class TypeOnlyImports(unittest.TestCase):
    def test_a_type_only_import_is_not_staged_as_a_copy(self):
        from declarations import type_imports, value_imports
        text = 'import type { Message } from "./main.vibe"\nimport { a } from "./a.vibe"\nimport type {\n  B,\n} from "../b.vibe"\nimport { type C } from "./c.vibe"\n'
        self.assertEqual(type_imports(text), ['./main.vibe', '../b.vibe'])
        self.assertEqual(sorted(value_imports(text)), ['./a.vibe', './c.vibe'])
        self.assertEqual(value_imports('import type { M } from "./m.vibe"\nimport { f } from "./m.vibe"\n'), ['./m.vibe'])

    def test_a_type_only_import_reads_a_declaration_only_when_the_module_is_not_typescript(self):
        from declarations import copied_imports, declared_imports
        app = ROOT.parent
        text = 'import type { Epic } from "./mythical.vibe"\nimport type { Message } from "../web/main.vibe"\n'
        self.assertEqual(copied_imports(text, app / 'src/history'), ['./mythical.vibe'])
        self.assertEqual(declared_imports(text, app / 'src/history'), ['../web/main.vibe'])

    def test_a_declaration_is_staged_with_absolute_specifiers_and_never_beside_a_copy(self):
        from declarations import stage
        app = ROOT.parent
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            folder = pathlib.Path(folder)
            (folder / 'copied.vibe.ts').write_text('export {}\n')
            written = stage(app, {folder / 'main.vibe.d.ts': app / 'src/web/main.vibe', folder / 'copied.vibe.d.ts': app / 'src/core/roles.vibe'}, folder / 'declarations')
            self.assertEqual(written, [folder / 'main.vibe.d.ts'])
            self.assertFalse((folder / 'copied.vibe.d.ts').exists())
            text = (folder / 'main.vibe.d.ts').read_text()
            self.assertIn('export type Message = typeof Message.Type', text)
            self.assertNotRegex(text, r'(?:from|import\()\s*"\.')
            self.assertRegex(text, r'from "/[^"]*/declarations/tree/src/core/conversation\.vibe"')

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

class TargetedInvariants(unittest.TestCase):
    def test_an_invariant_is_selected_inside_the_named_method(self):
        from mutation_targets import invariant_line
        generated = 'method other()\n{\n  while true\n    invariant kept\n  {\n  }\n}\nmethod target()\n{\n  while true\n    invariant (0 <= i)\n    invariant (kept)\n  {\n  }\n}\n'
        self.assertEqual(invariant_line(generated, 'target', 'kept'), 12)
        for function, clause in [('missing', 'kept'), ('target', 'different')]:
            with self.assertRaises(ValueError): invariant_line(generated, function, clause)
        ambiguous = generated.replace('    invariant (kept)', '    invariant (kept)\n    invariant (kept)', 1)
        with self.assertRaises(ValueError): invariant_line(ambiguous, 'target', 'kept')

    def test_every_targeted_invariant_names_a_mutation(self):
        from mutation_targets import INVARIANTS
        from extended_mutations import cases
        names = {case[1] for case in cases}
        self.assertTrue(INVARIANTS)
        self.assertLessEqual(set(INVARIANTS), names)

class MutantTimeLimits(unittest.TestCase):
    def test_a_named_slow_mutant_gets_its_own_limit_and_others_keep_thirty_seconds(self):
        from mutation_targets import TIME_LIMITS, time_limit
        self.assertEqual(time_limit('replay-order', True), 120)
        self.assertEqual(time_limit('receive-field-author', True), 120)
        self.assertEqual(time_limit('any-other-mutant', True), 30)
        self.assertEqual(time_limit('replay-order', False), 60)
        self.assertTrue(all(isinstance(v, int) and 30 < v <= 300 for v in TIME_LIMITS.values()))

    def test_the_wall_only_stops_a_hung_process(self):
        from mutation_targets import wall_limit
        self.assertEqual(wall_limit(False, True, 30), 1800)
        self.assertEqual(wall_limit(False, False, 60), 180)
        self.assertEqual(wall_limit(False, False, 180), 240)
        self.assertEqual(wall_limit(True, False, 120), 7200)

    def test_every_time_limit_names_a_mutation(self):
        from mutation_targets import TIME_LIMITS
        from extended_mutations import cases
        self.assertLessEqual(set(TIME_LIMITS), {case[1] for case in cases})

class FunctionAssertions(unittest.TestCase):
    def test_unguarded_assertion_is_confined_to_one_function(self):
        from mutation_targets import case_assertion_line
        source = 'method target()\n{\n  assert kept;\n}\nmethod other()\n{\n  assert kept;\n}\n'
        self.assertEqual(case_assertion_line(source, 'target', None, 'kept'), 3)
        with self.assertRaises(ValueError): case_assertion_line(source, 'missing', None, 'kept')
        with self.assertRaises(ValueError): case_assertion_line(source, 'target', None, 'missing')
        with self.assertRaises(ValueError): case_assertion_line(source.replace('  assert kept;', '  assert kept;\n  assert kept;', 1), 'target', None, 'kept')

class FailureLocation(unittest.TestCase):
    def test_a_failure_in_an_opaque_function_is_attributed_to_it(self):
        from sources import enclosing_symbol
        lines = ['function before(): int', '{ 0 }', 'opaque function step(n: int): int', '  ensures step(n) == n', '{', '  n', '}', 'lemma after_ensures()']
        self.assertEqual(enclosing_symbol(lines, 6), 'step')
        self.assertEqual(enclosing_symbol(lines, 2), 'before')
        self.assertEqual(enclosing_symbol(lines, 8), 'after_ensures')
        self.assertIsNone(enclosing_symbol(['// header'], 1))

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

    def test_a_lemma_that_only_reveals_takes_steps_after_its_reveals(self):
        from proof_additions import add_proof_steps, LEMMA_STEPS
        (prefix, prefix_steps), (signature, steps) = LEMMA_STEPS['src/history/replayDecision.vibe']
        source = prefix + '\n  ensures valid\n{\n}\n' + signature + '\n  requires valid\n  ensures valid\n{\n  reveal replayStep();\n}\n'
        result = add_proof_steps(source, 'src/history/replayDecision.vibe')
        self.assertEqual(result.replace(steps, '', 1).replace(prefix_steps, '', 1), source)
        self.assertLess(result.index('reveal replayStep();'), result.index(steps))
        for invalid in [source.replace('reveal replayStep();', 'assert valid;'), source.replace('reveal replayStep();', 'reveal replayStep();\n  assert valid;')]:
            with self.assertRaises(ValueError): add_proof_steps(invalid, 'src/history/replayDecision.vibe')

    def test_hand_steps_replace_the_contract_calls_lsc_fills_a_lemma_with(self):
        # Hand steps are a whole proof written without lsc's contract calls; stacking both timed out
        # issueAncestorJoin_ensures (0018 third-lane batch 31).
        from proof_additions import add_proof_steps, LEMMA_STEPS
        signature, steps = LEMMA_STEPS['src/core/sandboxDecision.vibe'][0]
        head = signature + '\n  requires 0 <= end\n  ensures valid\n  decreases end\n{\n'
        reveals = '  reveal f();\n'
        body = '  if end == 0 {\n  } else {\n    var x := f(end);\n    g_ensures(end - 1);\n    if (0 <= (end - 1)) { h_ensures(end - 1); }\n  }\n'
        result = add_proof_steps(head + reveals + body + '}\n', 'src/core/sandboxDecision.vibe')
        # lsc's `decreases` goes too: with it the lemma timed out at 300 s; without it, as on main, it proves in 7 s.
        self.assertEqual(result, head.replace('  decreases end\n', '') + reveals + steps + '}\n')
        source = head + body + '}\n'
        for invalid in [source.replace('g_ensures(end - 1);', 'assert valid;'), source.replace('    var x := f(end);\n', '    var x := f(end);\n    assume false;\n')]:
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
    CALL_ONLY = {'exit': 4, 'dfy': '/proof/target.dfy',
                 'output': 'target.dfy(20,0): Error: a precondition for this call could not be proved',
                 'diagnostics': [{'file':'/proof/target.dfy','line':20,'severity':'error','kind':'precondition','function':'replayEvent'}]}

    def test_a_callee_precondition_alone_is_never_a_rejection(self):
        from mutation_results import validate_rejection
        with self.assertRaises(ValueError): validate_rejection(self.CALL_ONLY,'replayEvent')

    def test_manifest_has_no_callee_domain_exceptions(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.checks') as folder:
            out=pathlib.Path(folder)
            names=['history-capacity-low','history-capacity-high','history-replay-capacity-gate','decide-blank']
            result=subprocess.run([sys.executable,str(ROOT/'mutations.py'),str(out),*names],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            manifest=json.loads((out/'manifest.json').read_text())
            self.assertEqual(set(manifest),set(names))
            self.assertTrue(all('callee_precondition' not in item for item in manifest.values()))

    def test_an_import_of_an_unmarked_module_is_refused(self):
        from sources import require_proved
        production=production_sources(ROOT.parent)
        require_proved(ROOT.parent/'src/core/conversation.vibe',production)
        with self.assertRaises(SystemExit):require_proved(ROOT.parent/'src/core/Factory.vibe',production)

    def test_direct_assertion_is_a_rejection_but_related_and_tool_errors_are_not(self):
        from mutation_results import validate_rejection
        result={'exit':4,'dfy':'/proof/target.dfy','output':'target.dfy(20,0): Error: assertion might not hold',
                'diagnostics':[{'file':'/proof/target.dfy','line':20,'severity':'error','kind':'assertion','function':'wanted'}]}
        validate_rejection(result,'wanted')
        for change in [{'exit':0},{'output':result['output']+'; timed out'},
                       {'output':result['output']+'; 2 resolution/type errors'},
                       {'output':result['output']+"; destructor 'id' can only be applied to constructor A"},
                       {'output':result['output']+'; resource limit exceeded'},
                       {'diagnostics':[{**result['diagnostics'][0],'severity':'related'}]},
                       {'diagnostics':[{**result['diagnostics'][0],'function':'other'}]}]:
            with self.assertRaises(ValueError):validate_rejection({**result,**change},'wanted')

    def test_diagnostic_mapping_uses_the_generated_file_and_direct_error_line(self):
        from proof_diagnostics import read_diagnostics
        from sources import dafny_keywords
        generated='method other()\n{\n}\nmethod wanted()\n{\n}\n'
        output='library.dfy(5,0): Error: assertion might not hold\n' \
               'target.dfy(2,0): Error: a postcondition could not be proved\n' \
               'target.dfy(5,0): Related location: this is the postcondition that could not be proved\n'
        found=read_diagnostics(output,generated,'/proof/target.dfy',[(1,'other'),(9,'wanted')],dafny_keywords())
        self.assertEqual([d['function'] for d in found],[None,'other','wanted'])
        self.assertEqual([d['severity'] for d in found],['error','error','related'])


    def test_a_quantified_contract_lemma_failure_is_a_postcondition(self):
        # mock-actor-key-sep: Dafny reports a failed forall-ensures in the function's contract lemma this way (2026-11-10).
        from proof_diagnostics import read_diagnostics
        from sources import dafny_keywords
        generated='function actorKey(id: string): string\n{ id }\nlemma actorKey_ensures()\n  ensures forall other :: actorKey(other) != ""\n{\n}\n'
        output='target.dfy(4,32): Error: possible violation of postcondition of forall statement\n'
        found=read_diagnostics(output,generated,'/proof/target.dfy',[(1,'actorKey')],dafny_keywords())
        self.assertEqual([(d['function'],d['kind']) for d in found],[('actorKey','postcondition')])

    def test_a_postcondition_of_an_opaque_function_is_its_own_failure(self):
        # conversation-step-applies: the opaque replay step fails its own postcondition (2026-11-10).
        from proof_diagnostics import read_diagnostics
        from sources import dafny_keywords
        generated='function other(): int\n{ 0 }\nopaque function step(n: int): int\n  ensures step(n) == n\n{\n  n\n}\n'
        output='target.dfy(6,2): Error: a postcondition could not be proved on this return path\n' \
               'target.dfy(4,10): Related location: this is the postcondition that could not be proved\n'
        found=read_diagnostics(output,generated,'/proof/target.dfy',[(1,'other'),(3,'step')],dafny_keywords())
        self.assertEqual([(d['function'],d['symbol']) for d in found],[('step','step'),('step','step')])


class ReviewRegressions(unittest.TestCase):
    def test_circular_imported_contracts_cannot_justify_each_other(self):
        from sources import proof_dependencies
        with tempfile.TemporaryDirectory(dir=ROOT/'.checks') as folder:
            app=pathlib.Path(folder)
            left=app/'left.vibe';right=app/'right.vibe'
            left.write_text('import { right } from "./right.vibe"\n//@ verify\n//@ ensures false\nexport function left(): boolean { return right() }\n')
            right.write_text('import { left } from "./left.vibe"\n//@ verify\n//@ ensures false\nexport function right(): boolean { return left() }\n')
            with self.assertRaisesRegex(SystemExit, 'Cyclic proof value imports'):
                proof_dependencies([left], [left,right])

    def test_unrelated_postcondition_does_not_validate_an_intended_precondition(self):
        from mutation_results import validate_rejection
        result = {
            'exit': 4, 'dfy': '/proof/target.dfy',
            'output': 'target.dfy(8,0): Error: a postcondition could not be proved\n'
                      'target.dfy(20,0): Error: a precondition for this call could not be proved\n',
            'mapped': ['source.vibe:1: function other [other; generated line 8]',
                       'source.vibe:9: function wanted [wanted; generated line 20]'],
            'diagnostics': [
                {'file': '/proof/target.dfy', 'line': 8, 'severity': 'error', 'kind': 'postcondition', 'function': 'other'},
                {'file': '/proof/target.dfy', 'line': 20, 'severity': 'error', 'kind': 'precondition', 'function': 'wanted'},
            ],
        }
        with self.assertRaises(ValueError): validate_rejection(result, 'wanted')

    def test_a_library_error_cannot_be_mapped_into_the_target_by_line_number(self):
        from mutation_results import validate_rejection
        result = {
            'exit': 4, 'dfy': '/proof/target.dfy',
            'output': 'library.dfy(20,0): Error: a postcondition could not be proved\n',
            'mapped': ['source.vibe:9: function wanted [wanted; generated line 20]'],
            'diagnostics': [
                {'file': '/proof/library.dfy', 'line': 20, 'severity': 'error', 'kind': 'postcondition', 'function': 'wanted'},
            ],
        }
        with self.assertRaises(ValueError): validate_rejection(result, 'wanted')

    def test_a_marked_module_cannot_export_an_unproved_contract(self):
        from sources import require_proved
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            dependency=pathlib.Path(folder)/'dependency.vibe'
            dependency.write_text(r'''//@ verify
//@ ensures \result
export function proved(): boolean { return true }
//@ ensures \result
export function lie(): boolean { return false }
''')
            with self.assertRaises(SystemExit): require_proved(dependency, [dependency])

    def test_an_explicit_typescript_caller_cannot_trust_an_unlisted_typescript_contract(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.checks') as folder:
            app=pathlib.Path(folder);(app/'src').mkdir()
            (app/'tsconfig.json').write_text(json.dumps({'extends':str(ROOT.parent/'tsconfig.json'),'files':[],'include':[]}))
            (app/'src/library.ts').write_text('//@ ensures \\result\nexport function lie(): boolean { return false }\n')
            caller=app/'src/caller.ts'
            caller.write_text("import { lie } from './library.ts'\n//@ verify\n//@ ensures \\result\nexport function trusted(): boolean { return lie() }\n")
            env={k:v for k,v in os.environ.items() if k!='VERIFY_MUTATION_MANIFEST'}
            env['VIBELANG_VERIFY_ROOT']=str(app)
            result=subprocess.run([sys.executable,str(ROOT/'check.py'),str(caller)],capture_output=True,text=True,env=env,timeout=120)
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('not a marked production module',result.stdout+result.stderr)

    def test_a_selected_caller_cannot_trust_a_false_imported_contract(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            app=pathlib.Path(folder);(app/'src').mkdir()
            (app/'tsconfig.json').write_text(json.dumps({'extends':str(ROOT.parent/'tsconfig.json'),'files':[],'include':[]}))
            (app/'src/callee.vibe').write_text(r'''//@ verify
//@ ensures \result
export function lie(): boolean { return false }
''')
            caller=app/'src/caller.vibe'
            caller.write_text(r'''import { lie } from "./callee.vibe"
//@ verify
//@ ensures \result
export function trusted(): boolean { return lie() }
''')
            env={k:v for k,v in os.environ.items() if k!='VERIFY_MUTATION_MANIFEST'}
            env['VIBELANG_VERIFY_ROOT']=str(app)
            result=subprocess.run([sys.executable,str(ROOT/'check.py'),str(caller)],capture_output=True,text=True,env=env,timeout=120)
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('function lie',result.stdout+result.stderr)

COUNT = """//@ verify
//@ requires 0 <= end && end <= xs.length
//@ ensures 0 <= \\result && \\result <= end
//@ decreases end
spec function countPrefix(xs: ReadonlyArray<boolean>, end: number): number {
  if (end <= 0) return 0
  return countPrefix(xs, end - 1) + (xs[end - 1]! ? 1 : 0)
}

"""


class SpecFunctions(unittest.TestCase):
    """A `spec function` (VIP-43) is proved as VibeLang lowers it: an exported function (spec_functions.py)."""

    def check(self, text):
        env = {key: value for key, value in os.environ.items() if key not in ('VIBELANG_VERIFY_ROOT', 'VERIFY_MUTATION_MANIFEST')}
        import shutil
        folder = tempfile.mkdtemp(dir=ROOT / '.checks')
        self.addCleanup(shutil.rmtree, folder, True)
        source = pathlib.Path(folder) / 'count.vibe'
        source.write_text(text)
        result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(source)], capture_output=True, text=True, env=env)
        return source, result

    def test_a_loop_is_proved_against_a_spec_function(self):
        source, result = self.check(COUNT + """//@ verify
//@ ensures \\result == countPrefix(xs, xs.length)
export function count(xs: ReadonlyArray<boolean>): number {
  let total = 0
  for (let i = 0; i < xs.length; i++) {
    //@ invariant 0 <= i && i <= xs.length
    //@ invariant total == countPrefix(xs, i)
    //@ decreases xs.length - i
    if (xs[i]!) total++
  }
  return total
}
""")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        summary = json.loads(pathlib.Path(result.stdout.rsplit('results: ', 1)[1].strip()).read_text())
        generated = pathlib.Path(summary['results'][0]['dfy']).read_text()
        self.assertIn('function countPrefix(', generated)
        self.assertNotIn('ghost function countPrefix(', generated)
        self.assertEqual(source.read_text().count('spec function'), 1, 'the original is never rewritten')

    def test_an_unmarked_spec_function_contract_in_a_proof_import_is_refused(self):
        from sources import require_proved
        folder = pathlib.Path(tempfile.mkdtemp(dir=ROOT / '.checks'))
        import shutil
        self.addCleanup(shutil.rmtree, folder, True)
        dependency = folder / 'dep.vibe'
        dependency.write_text('//@ ensures \\result >= 0\nspec function f(n: number): number {\n  return n\n}\n')
        with self.assertRaisesRegex(SystemExit, 'contract on unmarked function f'):
            require_proved(dependency, [dependency])

    def test_only_the_form_at_a_line_start_is_lowered(self):
        from spec_functions import lower
        self.assertEqual(lower('  spec function f() {}\n'), '  export function f() {}\n')
        for kept in ['const spec = 1\n', 'spec\nfunction f() {}\n', '// spec function f\n', 'specs function f() {}\n']:
            self.assertEqual(lower(kept), kept)


class ProofReuse(unittest.TestCase):
    """A passing proof is reused while nothing it reads changes; any change re-proves it (proof_cache.py, 0018)."""

    CALLEE = '//@ verify\n//@ ensures \\result >= n\nexport function atLeast(n: number): number { return n + 1 }\n'
    CALLER = 'import { atLeast } from "./callee.vibe"\n//@ verify\n//@ ensures \\result > n\nexport function above(n: number): number { return atLeast(n) + 1 }\n'

    def app(self):
        import shutil
        app = pathlib.Path(tempfile.mkdtemp(dir=ROOT / '.checks'))
        self.addCleanup(shutil.rmtree, app, True)
        (app / 'src').mkdir()
        (app / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json'), 'files': [], 'include': []}))
        (app / 'src/callee.vibe').write_text(self.CALLEE)
        (app / 'src/caller.vibe').write_text(self.CALLER)
        return app

    def check(self, app, **extra):
        env = {k: v for k, v in os.environ.items() if k not in ('VERIFY_MUTATION_MANIFEST', 'VERIFY_FRESH')}
        env.update(VIBELANG_VERIFY_ROOT=str(app), **extra)
        result = subprocess.run([sys.executable, str(ROOT / 'check.py'), str(app / 'src/caller.vibe')], capture_output=True, text=True, env=env, timeout=600)
        summary = json.loads(pathlib.Path(result.stdout.rsplit('results: ', 1)[1].strip()).read_text())
        proved = sorted(pathlib.Path(c['argv'][-1]).stem for c in summary['commands'] if pathlib.Path(c['argv'][0]).name == 'dafny')
        return result, summary, proved

    def test_an_unchanged_import_is_reused_and_any_change_reproves(self):
        app = self.app()
        first, _, proved = self.check(app)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(proved, ['callee', 'caller'])
        again, summary, proved = self.check(app)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(proved, [], 'nothing changed, so nothing is proved again')
        self.assertEqual(sorted(pathlib.Path(r['file']).name for r in summary['results'] if r.get('cached')), ['callee.vibe', 'caller.vibe'])
        _, _, proved = self.check(app, VERIFY_FRESH='1')
        self.assertEqual(proved, ['callee', 'caller'], 'VERIFY_FRESH proves every module')
        (app / 'src/callee.vibe').write_text(self.CALLEE.replace('n + 1', 'n + 2'))
        changed, _, proved = self.check(app)
        self.assertEqual(changed.returncode, 0, changed.stdout + changed.stderr)
        self.assertEqual(proved, ['callee', 'caller'], 'a changed value import re-proves it and its importer')
        (app / 'src/caller.vibe').write_text(self.CALLER.replace('+ 1 }', '+ 2 }'))
        _, _, proved = self.check(app)
        self.assertEqual(proved, ['caller'], 'a changed importer reuses its unchanged import')

    def test_a_failed_proof_is_never_reused(self):
        app = self.app()
        (app / 'src/callee.vibe').write_text(self.CALLEE.replace('n + 1', 'n - 1'))
        for attempt in range(2):
            failed, _, proved = self.check(app)
            self.assertNotEqual(failed.returncode, 0, failed.stdout)
            self.assertIn('callee', proved, attempt)

    def test_a_changed_tool_build_changes_the_key(self):
        from proof_cache import tools_digest
        with tempfile.TemporaryDirectory(dir=ROOT / '.checks') as folder:
            root = pathlib.Path(folder)
            (root / 'package/tools/dist').mkdir(parents=True)
            (root / 'tools/bin').mkdir(parents=True)
            (root / 'package/tools/dist/lsc.js').write_text('one\n')
            (root / 'tools/bin/lsc').symlink_to(root / 'package/tools/dist/lsc.js')
            before = tools_digest(root / 'tools', root / 'package')
            (root / 'package/tools/dist/extract.js').write_text('two\n')
            self.assertNotEqual(tools_digest(root / 'tools', root / 'package'), before)

    def test_a_run_folder_and_checkout_path_do_not_decide_a_key(self):
        from proof_cache import normalize
        run = pathlib.Path('/x/apps/vibelang/verify/.checks/run-abc')
        self.assertEqual(normalize(f'import "{run}/declarations/tree/src/a.vibe"', run, pathlib.Path('/x')),
                         'import "<run>/declarations/tree/src/a.vibe"')

if __name__ == '__main__':
    (ROOT / '.checks').mkdir(exist_ok=True)
    unittest.main()
