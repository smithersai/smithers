"""Deterministic resource-readiness regressions for the real forecast scheduler.

python3 -m unittest discover -s .specs/engineering/forecast -p 'test_*.py'
"""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest


class SchedulerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = Path(__file__).with_name("sched.py")
        params = {
            "start": "2026-10-02T16:50", "lanes": 1, "runs": 1,
            "hours": {"S": [1, 1], "M": [1, 1], "L": [1, 1]},
            "yield": 1, "rework": [1, 1], "s1_roots": ["T-UI-01"],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "params.json")
            path.write_text(json.dumps(params))
            argv = sys.argv
            try:
                sys.argv = [str(script), str(path)]
                with contextlib.redirect_stdout(io.StringIO()):
                    namespace = runpy.run_path(str(script))
            finally:
                sys.argv = argv
        cls.simulate = staticmethod(namespace["sim"])
        cls.model = namespace["sim"].__globals__

    def schedule(self, tasks, durations=None, **params):
        durations = durations or {}
        sizes = {"S": 1, "M": 2, "L": 3}
        tickets = {t: {"size": size, "deps": set(deps)} for t, (size, deps) in tasks.items()}
        self.model.update(
            P={"lanes": 1, "design_lanes": 1, "yield": 1, **params},
            T=tickets, work=list(tasks), need=set(tasks), done=set(),
            w=sizes, memo={}, INTEG=None,
            # Deterministic inputs still pass through the production duration function.
            H={size: lambda value=durations.get(size, 1.0): value for size in sizes}, CI=lambda: 0.0, RW=lambda: 0.0,
            REV=lambda: 1.0, FIX=lambda: 0.5,
            succ={t: [u for u in tasks if t in tickets[u]["deps"]] for t in tasks},
        )
        return self.simulate()

    def test_delayed_design_does_not_reserve_idle_code_capacity(self):
        end, chain = self.schedule({
            "T-UI-01": ("S", []),
            "T-APP-01": ("L", ["T-UI-01"]),
            "T-APP-02": ("S", []),
        }, design_start_h=10)
        self.assertEqual(end, 12.0)
        self.assertEqual(chain, ("T-UI-01", "T-APP-01"))

    def test_many_independent_jobs_fill_the_gap_before_future_work(self):
        for count in range(1, 9):
            with self.subTest(count=count):
                tasks = {
                    "T-UI-01": ("S", []),
                    "T-APP-01": ("L", ["T-UI-01"]),
                    **{f"T-FREE-{i:02}": ("S", []) for i in range(count)},
                }
                self.assertEqual(self.schedule(tasks, design_start_h=10)[0], 12.0)

    def test_longest_path_breaks_equal_start_ties(self):
        end, chain = self.schedule({
            "T-APP-01": ("L", []),
            "T-APP-02": ("L", ["T-APP-01"]),
            "T-APP-03": ("S", []),
        })
        self.assertEqual(end, 3.0)
        self.assertEqual(chain, ("T-APP-03",))

    def test_separate_pools_run_concurrently(self):
        end, _ = self.schedule({
            "T-UI-01": ("S", []),
            "T-APP-01": ("S", []),
        })
        self.assertEqual(end, 1.0)

    def test_extra_code_lane_waits_until_its_availability(self):
        tasks = {f"T-APP-{i:02}": ("S", []) for i in range(5)}
        self.assertEqual(self.schedule(tasks, extra_lanes=[[2.0, 1]])[0], 4.0)

    def test_future_review_does_not_block_an_earlier_review(self):
        end, _ = self.schedule({
            "T-APP-01": ("L", []),
            "T-APP-02": ("S", []),
        }, durations={"L": 10.0}, lanes=2, review_lanes=1, review_yield=1)
        self.assertEqual(end, 11.0)

    def test_gap_requires_enough_room_for_the_whole_job(self):
        first_gap = self.model["first_gap"]
        for reserved in [[(3, 5), (8, 10)], [(8, 10), (3, 5)]]:
            self.assertEqual(first_gap(0, reserved, 0, 3), 0)
            self.assertEqual(first_gap(0, reserved, 2, 3), 5)
            self.assertEqual(first_gap(0, reserved, 2, 4), 10)
            self.assertEqual(first_gap(6, reserved, 0, 1), 6)
            self.assertEqual(first_gap(0, reserved, 12, 1), 12)

    def test_dependency_completion_remains_a_start_precondition(self):
        end, chain = self.schedule({
            "T-UI-01": ("S", []),
            "T-APP-01": ("S", ["T-UI-01"]),
            "T-APP-02": ("S", ["T-APP-01"]),
        }, design_start_h=10, lanes=2)
        self.assertEqual(end, 13.0)
        self.assertEqual(chain, ("T-UI-01", "T-APP-01", "T-APP-02"))


if __name__ == "__main__":
    unittest.main()
