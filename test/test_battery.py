"""Pure-logic tests for the battery service (no ROS graph, no processes)."""
import os
import sys
import time
import unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pydantic import ValidationError  # noqa: E402

from robot_dashboard import battery as b  # noqa: E402


class ConfigTest(unittest.TestCase):
    def test_defaults_are_valid(self):
        c = b.BatteryConfig()
        self.assertEqual((c.state_topic, c.bms_topic), ("/battery_state", "/hdas/bms"))

    def test_rejects_relative_or_spaced_topics(self):
        for bad in ("battery_state", "/has space", ""):
            with self.assertRaises(ValidationError):
                b.BatteryConfig(state_topic=bad)

    def test_rejects_inverted_or_out_of_range_thresholds(self):
        for kw in (dict(warn_pct=10, critical_pct=20), dict(warn_pct=101), dict(critical_pct=-1), dict(stale_sec=0)):
            with self.assertRaises(ValidationError, msg=kw):
                b.BatteryConfig(**kw)

    def test_unknown_capital_mode_rejected(self):
        with self.assertRaises(ValidationError):
            b.BatteryConfig(capital_mode="mah")


class CommandTest(unittest.TestCase):
    def test_command_carries_every_setting(self):
        c = b.BatteryConfig(bms_topic="/x/bms", state_topic="/x/state", capital_mode="percent",
                            warn_pct=30, critical_pct=12, stale_sec=7)
        cmd = b.monitor_command(c)
        self.assertEqual(cmd[:4], ["ros2", "run", "battery_monitor", "battery_monitor"])
        for expected in ("bms_topic:=/x/bms", "out_topic:=/x/state", "capital_mode:=percent",
                         "warn_pct:=30.0", "critical_pct:=12.0", "stale_sec:=7.0"):
            self.assertIn(expected, cmd)

    def test_env_prepends_hdas_paths_and_keeps_existing(self):
        c = b.BatteryConfig(hdas_msg_path="/opt/galaxea/hdas_msg")
        env = b.monitor_env(c, {"PYTHONPATH": "/a", "LD_LIBRARY_PATH": "/opt/ros/humble/lib", "HOME": "/h"})
        self.assertEqual(env["PYTHONPATH"], "/opt/galaxea/hdas_msg/local/lib/python3.10/dist-packages:/a")
        self.assertEqual(env["LD_LIBRARY_PATH"], "/opt/galaxea/hdas_msg/lib:/opt/ros/humble/lib")
        self.assertEqual(env["HOME"], "/h")

    def test_env_with_nothing_preset_and_tilde_expansion(self):
        c = b.BatteryConfig(hdas_msg_path="~/g/hdas_msg")
        env = b.monitor_env(c, {})
        self.assertEqual(env["LD_LIBRARY_PATH"], os.path.expanduser("~/g/hdas_msg/lib"))
        self.assertNotIn(":", env["LD_LIBRARY_PATH"])


class LevelTest(unittest.TestCase):
    def test_levels(self):
        c = b.BatteryConfig()
        self.assertEqual([b.battery_level(p, c) for p in (80, 25, 24.9, 10, 9.9, 0)],
                         ["ok", "ok", "warn", "warn", "critical", "critical"])
        self.assertEqual(b.battery_level(None, c), "unknown")


class StatusTest(unittest.TestCase):
    def service(self, **kw):
        svc = b.BatteryService(None, None, b.BatteryConfig(**kw))
        return svc

    def msg(self, pct=0.5, v=50.0, i=-3.0):
        return NS(percentage=pct, voltage=v, current=i)

    def test_no_data_is_unknown_and_stale(self):
        s = self.service().status()
        self.assertIsNone(s["data"])
        self.assertTrue(s["stale"])
        self.assertEqual(s["level"], "unknown")

    def test_fresh_data_converts_fraction_to_percent(self):
        svc = self.service()
        svc._on_state(self.msg(0.18))
        s = svc.status()
        self.assertFalse(s["stale"])
        self.assertAlmostEqual(s["data"]["percentage"], 18.0)
        self.assertEqual(s["level"], "warn")

    def test_nan_fields_become_none_and_level_unknown(self):
        svc = self.service()
        svc._on_state(self.msg(pct=float("nan"), i=float("nan")))
        s = svc.status()
        self.assertIsNone(s["data"]["percentage"])
        self.assertIsNone(s["data"]["current"])
        self.assertEqual(s["data"]["voltage"], 50.0)
        self.assertEqual(s["level"], "unknown")

    def test_old_data_goes_stale_and_level_unknown(self):
        svc = self.service(stale_sec=1.0)
        svc._on_state(self.msg(0.05))
        svc._last_rx = time.monotonic() - 2.0
        s = svc.status()
        self.assertTrue(s["stale"])
        self.assertEqual(s["level"], "unknown")   # never a green/red from an old reading
        self.assertIsNotNone(s["data"])           # but the last values are still reported

    def test_monitor_state_disabled_when_not_spawning(self):
        self.assertEqual(self.service(spawn_monitor=False).status()["monitor"]["state"], "disabled")
        self.assertEqual(self.service(spawn_monitor=True).status()["monitor"]["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
