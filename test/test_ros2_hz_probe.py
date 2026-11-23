"""Probe tests with a fake `ros2 topic hz` (a python one-liner) - no ROS graph."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from robot_dashboard.graph import ros2_hz_probe as rhp  # noqa: E402
from robot_dashboard.graph.ros2_hz_probe import Ros2HzProbe, parse_rate_line, parse_window_line  # noqa: E402

PRINTER = (
    "import sys,time\n"
    "for i in range(1000):\n"
    "    print('average rate: 29.987')\n"
    "    print('\\tmin: 0.033s max: 0.034s std dev: 0.00041s window: %d' % (i+30))\n"
    "    sys.stdout.flush(); time.sleep(0.1)\n"
)


def fake(script):
    return lambda topic: [sys.executable, "-u", "-c", script]


def wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


class ParseTest(unittest.TestCase):
    def test_rate_and_window_lines(self):
        self.assertEqual(parse_rate_line("average rate: 29.987\n"), 29.987)
        self.assertEqual(parse_rate_line("average rate: 0.500"), 0.5)
        self.assertIsNone(parse_rate_line("\tmin: 0.033s max: 0.034s std dev: 0.00041s window: 30"))
        self.assertEqual(parse_window_line("\tmin: 0.033s max: 0.034s std dev: 0.00041s window: 30"), 30)
        self.assertIsNone(parse_window_line("average rate: 29.987"))
        self.assertIsNone(parse_rate_line("WARNING: topic [/x] does not appear to be published yet"))


class ProbeTest(unittest.TestCase):
    def tearDown(self):
        rhp.stop_all()

    def test_reports_rate_and_window_then_stop_kills_the_process(self):
        p = Ros2HzProbe("/t", fake(PRINTER))
        p.start()
        self.assertTrue(wait_for(lambda: p.snapshot()["ros2_hz"] is not None))
        snap = p.snapshot()
        self.assertAlmostEqual(snap["ros2_hz"], 29.987)
        self.assertIsNotNone(snap["ros2_window"])
        self.assertIsNone(snap["ros2_error"])
        proc = p._proc
        p.stop()
        self.assertTrue(wait_for(lambda: proc.poll() is not None), "process still alive after stop()")
        time.sleep(0.2)
        self.assertIsNone(p.snapshot()["ros2_error"], "a requested stop is not an error")

    def test_value_goes_stale_when_the_cli_stops_printing(self):
        quiet = ("import sys,time\nprint('average rate: 10.000'); sys.stdout.flush()\ntime.sleep(60)\n")
        old = rhp.STALE_AFTER_SEC
        rhp.STALE_AFTER_SEC = 0.5
        try:
            p = Ros2HzProbe("/t", fake(quiet))
            p.start()
            self.assertTrue(wait_for(lambda: p.snapshot()["ros2_hz"] == 10.0))
            self.assertTrue(wait_for(lambda: p.snapshot()["ros2_hz"] is None), "frozen value was not dropped")
            p.stop()
        finally:
            rhp.STALE_AFTER_SEC = old

    def test_unexpected_exit_is_reported_with_its_last_line(self):
        p = Ros2HzProbe("/t", fake("import sys\nprint('boom: no such topic'); sys.exit(3)\n"))
        p.start()
        self.assertTrue(wait_for(lambda: p.snapshot()["ros2_error"] is not None))
        err = p.snapshot()["ros2_error"]
        self.assertIn("(3)", err)
        self.assertIn("boom: no such topic", err)
        self.assertIsNone(p.snapshot()["ros2_hz"])

    def test_missing_executable_is_an_error_not_an_exception(self):
        p = Ros2HzProbe("/t", lambda t: ["definitely-not-a-real-binary", t])
        p.start()
        self.assertIn("not found on PATH", p.snapshot()["ros2_error"])

    def test_stop_all_kills_live_probes(self):
        p = Ros2HzProbe("/t", fake(PRINTER))
        p.start()
        proc = p._proc
        rhp.stop_all()
        self.assertTrue(wait_for(lambda: proc.poll() is not None))


if __name__ == "__main__":
    unittest.main()
