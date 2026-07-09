import unittest
from unittest.mock import patch

from . import run_strategy
from .pso import _assign_tracks, _eligible_tracks, _roi_plan, _search_plan
from . import proposed_v2 as proposed
from .proposed_v2 import ABLATION_OPTIONS, _assignment_cost, _eligible_sonars, _optimize_assignments
from . import proposed_v3


def snapshot(tracks=None):
    return {
        "simulationTime": 1.0,
        "seed": 1337,
        "pool": {"width": 20, "length": 50},
        "physics": {
            "speedOfSound": 1500,
            "slewSpeed": 45,
            "scanStepAngle": 1,
            "processingOverheadSec": 0.002,
            "scanStepOverheadSec": 0.005,
            "receiveGuardFactor": 1.1,
            "samplesPerBeam": 256,
            "samplePeriodSec": 0.000005,
            "maxRange": 50,
            "tdmaSlotCount": 4,
        },
        "sonars": [
            {"id": "S1", "position": {"x": 0, "y": 0}, "mountAngle": 45, "mountYaw": -45, "currentAngle": 315, "currentLocalAngle": 0, "minLocalAngle": 0, "maxLocalAngle": 180},
            {"id": "S2", "position": {"x": 20, "y": 0}, "mountAngle": 135, "mountYaw": 45, "currentAngle": 45, "currentLocalAngle": 0, "minLocalAngle": 0, "maxLocalAngle": 180},
            {"id": "S3", "position": {"x": 20, "y": 50}, "mountAngle": 225, "mountYaw": 135, "currentAngle": 135, "currentLocalAngle": 0, "minLocalAngle": 0, "maxLocalAngle": 180},
            {"id": "S4", "position": {"x": 0, "y": 50}, "mountAngle": 315, "mountYaw": 225, "currentAngle": 225, "currentLocalAngle": 0, "minLocalAngle": 0, "maxLocalAngle": 180},
        ],
        "tracks": tracks or [],
    }


class StrategyTests(unittest.TestCase):
    def test_naive_returns_full_sector(self):
        result = run_strategy("NAIVE", snapshot())
        self.assertEqual(result["strategy"], "NAIVE")
        self.assertEqual(result["plans"][0]["minLocalAngle"], 0)
        self.assertEqual(result["plans"][0]["maxLocalAngle"], 180)
        self.assertEqual(result["plans"][0]["range"], 50)

    def test_nearest_roi_returns_roi_for_tracked_swimmer(self):
        tracks = [{
            "id": "T0001",
            "position": {"x": 4, "y": 10},
            "velocity": {"x": 0.4, "y": 1.1},
            "confidence": 0.8,
            "status": "confirmed",
        }]
        result = run_strategy("NEAREST_ROI", snapshot(tracks))
        self.assertEqual(result["strategy"], "NEAREST_ROI")
        plans = result["plans"]
        self.assertEqual(len(plans), 4)
        self.assertTrue(any(p["action"] == "TRACK_ROI" for p in plans))
        self.assertTrue(any(p["action"] == "FULL_SWEEP" for p in plans))

    def test_e2e_baselines_are_registered(self):
        tracks = [
            {"id": "T1", "position": {"x": 4, "y": 10}, "confidence": 0.8, "status": "confirmed"},
            {"id": "T2", "position": {"x": 16, "y": 35}, "confidence": 0.8, "status": "confirmed"},
        ]
        for strategy_id in [
            "FULL_SCAN",
            "ROUND_ROBIN_SECTOR",
            "ROUND_ROBIN_ROI",
            "NEAREST_ROI",
        ]:
            with self.subTest(strategy=strategy_id):
                result = run_strategy(strategy_id, snapshot(tracks))
                self.assertEqual(result["strategy"], strategy_id)
                self.assertEqual(len(result["plans"]), 4)

    def test_max_aoi_greedy_assigns_all_tracks(self):
        tracks = [
            {"id": "T1", "position": {"x": 4, "y": 10}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 5},
            {"id": "T2", "position": {"x": 16, "y": 35}, "confidence": 0.7, "status": "confirmed", "timeSinceUpdate": 2},
        ]
        result = run_strategy("MAX_AOI_GREEDY", snapshot(tracks))
        self.assertEqual(result["strategy"], "MAX_AOI_GREEDY")
        assigned = [tid for p in result["plans"] for tid in p["assignedTargetIds"]]
        self.assertCountEqual(assigned, ["T1", "T2"])

    def test_pso_returns_bounded_plans_and_assigns_every_track(self):
        tracks = [
            {
                "id": "T0001",
                "position": {"x": 4, "y": 10},
                "velocity": {"x": 0.4, "y": 1.1},
                "confidence": 0.8,
                "status": "confirmed",
            },
            {
                "id": "T0002",
                "position": {"x": 16, "y": 35},
                "velocity": {"x": -0.3, "y": -1.0},
                "confidence": 0.7,
                "status": "confirmed",
            },
        ]
        result = run_strategy("PSO_V1", snapshot(tracks))
        self.assertEqual(result["strategy"], "PSO_V1")
        assigned = [
            target_id
            for plan in result["plans"]
            for target_id in plan["assignedTargetIds"]
        ]
        self.assertCountEqual(assigned, ["T0001", "T0002"])
        for plan in result["plans"]:
            self.assertGreaterEqual(plan["range"], 1)
            self.assertLessEqual(plan["range"], 50)
            self.assertLess(plan["minLocalAngle"], plan["maxLocalAngle"])
        self.assertTrue(any(plan["action"] == "TRACK_ROI" for plan in result["plans"]))
        self.assertTrue(any(plan["action"] == "SEARCH_SECTOR" for plan in result["plans"]))

    def test_pso_assigns_tracks_to_correct_sonars(self):
        tracks = [
            {
                "id": "T0001",
                "position": {"x": 4, "y": 10},
                "confidence": 0.8,
                "status": "confirmed",
                "timeSinceUpdate": 2.0,
            },
            {
                "id": "T0002",
                "position": {"x": 16, "y": 35},
                "confidence": 0.7,
                "status": "confirmed",
                "timeSinceUpdate": 1.0,
            },
        ]
        snap = snapshot(tracks)
        eligible = _eligible_tracks(snap)
        self.assertEqual(len(eligible), 2)
        groups = _assign_tracks(snap, {})
        total_assigned = sum(len(g) for g in groups)
        self.assertEqual(total_assigned, 2)

    def test_roi_plan_produces_valid_bounds(self):
        sonar = {"id": "S1", "mountAngle": 45, "mountYaw": -45, "minLocalAngle": 0, "maxLocalAngle": 180, "position": {"x": 0, "y": 0}}
        track = {"id": "T1", "position": {"x": 4, "y": 10}}
        plan = _roi_plan(sonar, [track], 50)
        self.assertEqual(plan["action"], "TRACK_ROI")
        self.assertGreater(plan["maxLocalAngle"], plan["minLocalAngle"])
        self.assertGreater(plan["range"], 0)

    def test_belief_pso_is_deterministic_and_improves_seed_assignment(self):
        tracks = [
            {"id": "T1", "position": {"x": 4, "y": 12}, "velocity": {"x": 0.2, "y": 1.0}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 4.0, "covariance": [[2, 0], [0, 2]]},
            {"id": "T2", "position": {"x": 15, "y": 36}, "velocity": {"x": -0.3, "y": -0.9}, "confidence": 0.75, "status": "confirmed", "timeSinceUpdate": 2.0, "covariance": [[1, 0], [0, 1]]},
            {"id": "T3", "position": {"x": 10, "y": 24}, "velocity": {"x": 0.5, "y": 0.2}, "confidence": 0.7, "status": "confirmed", "timeSinceUpdate": 6.0, "covariance": [[4, 0], [0, 3]]},
        ]
        snap = snapshot(tracks)
        first = _optimize_assignments(snap, tracks)
        second = _optimize_assignments(snap, tracks)
        nearest = [min(
            _eligible_sonars(snap, track),
            key=lambda index: ((snap["sonars"][index]["position"]["x"] - track["position"]["x"]) ** 2 + (snap["sonars"][index]["position"]["y"] - track["position"]["y"]) ** 2),
        ) for track in tracks]
        self.assertEqual(first, second)
        self.assertLessEqual(_assignment_cost(snap, tracks, first), _assignment_cost(snap, tracks, nearest) + 1e-9)

        result = run_strategy("BELIEF_PSO_V2", snap)
        self.assertEqual(result["strategy"], "BELIEF_PSO_V2")
        assigned = [target_id for plan in result["plans"] for target_id in plan["assignedTargetIds"]]
        self.assertTrue(set(track["id"] for track in tracks).issubset(set(assigned)))
        self.assertTrue(all(0 <= plan["minLocalAngle"] < plan["maxLocalAngle"] <= 180 for plan in result["plans"]))

    def test_belief_pso_default_invokes_pso_assignment(self):
        tracks = [
            {"id": "T1", "position": {"x": 3, "y": 8}, "velocity": {"x": 0.05, "y": 1.0}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 4.0, "covariance": [[2, 0], [0, 2]]},
            {"id": "T2", "position": {"x": 7, "y": 18}, "velocity": {"x": 0.03, "y": 1.1}, "confidence": 0.75, "status": "confirmed", "timeSinceUpdate": 2.0, "covariance": [[1, 0], [0, 1]]},
            {"id": "T3", "position": {"x": 11, "y": 28}, "velocity": {"x": 0.04, "y": -1.0}, "confidence": 0.78, "status": "confirmed", "timeSinceUpdate": 3.0, "covariance": [[2, 0], [0, 2]]},
            {"id": "T4", "position": {"x": 15, "y": 36}, "velocity": {"x": 0.02, "y": -1.2}, "confidence": 0.82, "status": "confirmed", "timeSinceUpdate": 1.0, "covariance": [[1, 0], [0, 1]]},
            {"id": "T5", "position": {"x": 17, "y": 44}, "velocity": {"x": 0.01, "y": 0.9}, "confidence": 0.77, "status": "confirmed", "timeSinceUpdate": 5.0, "covariance": [[3, 0], [0, 3]]},
        ]
        snap = snapshot(tracks)
        self.assertTrue(proposed.DEFAULT_OPTIONS["pso"])
        with patch("strategies.proposed_v2._optimize_assignments", wraps=proposed._optimize_assignments) as optimize:
            result = run_strategy("BELIEF_PSO_V2", snap)
            self.assertGreater(optimize.call_count, 0)
            diagnostics = result.get("diagnostics", {})
            self.assertTrue(diagnostics.get("psoEnabled"))
            self.assertTrue(diagnostics.get("psoEligible"))
            self.assertIn("psoAccepted", diagnostics)
            self.assertEqual(diagnostics.get("trackCount"), len(tracks))
            self.assertEqual(diagnostics.get("sonarCount"), len(snap["sonars"]))
            self.assertEqual(diagnostics.get("psoMode"), "constrained_all_tracks")
            self.assertIsNone(diagnostics.get("rejectionReason"))

        with patch("strategies.proposed_v2._optimize_assignments", wraps=proposed._optimize_assignments) as optimize:
            result = run_strategy("BELIEF_PSO_NO_PSO", snap)
            self.assertEqual(optimize.call_count, 0)
            diagnostics = result.get("diagnostics", {})
            self.assertFalse(diagnostics.get("psoEnabled"))
            self.assertFalse(diagnostics.get("psoEligible"))
            self.assertEqual(diagnostics.get("rejectionReason"), "pso_disabled")

    def test_belief_pso_invokes_constrained_pso_without_lane_gate(self):
        tracks = [
            {"id": "T1", "position": {"x": 4, "y": 12}, "velocity": {"x": 1.0, "y": 0.1}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 1.0, "covariance": [[1, 0], [0, 1]]},
            {"id": "T2", "position": {"x": 16, "y": 38}, "velocity": {"x": -1.0, "y": 0.1}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 1.0, "covariance": [[1, 0], [0, 1]]},
        ]
        snap = snapshot(tracks)
        with patch("strategies.proposed_v2._optimize_assignments", wraps=proposed._optimize_assignments) as optimize:
            result = run_strategy("BELIEF_PSO_V2", snap)
            self.assertEqual(result["strategy"], "BELIEF_PSO_V2")
            self.assertGreater(optimize.call_count, 0)
            self.assertTrue(result.get("diagnostics", {}).get("psoEligible"))

    def test_belief_pso_v3_is_independent_strategy(self):
        tracks = [
            {"id": "T1", "position": {"x": 4, "y": 12}, "velocity": {"x": 0.2, "y": 1.0}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 4.0, "covariance": [[2, 0], [0, 2]]},
            {"id": "T2", "position": {"x": 15, "y": 36}, "velocity": {"x": -0.3, "y": -0.9}, "confidence": 0.75, "status": "confirmed", "timeSinceUpdate": 2.0, "covariance": [[1, 0], [0, 1]]},
        ]
        snap = snapshot(tracks)
        with patch("strategies.proposed_v3._optimize_assignments", wraps=proposed_v3._optimize_assignments) as optimize:
            result = run_strategy("BELIEF_PSO_V3", snap)
            self.assertEqual(result["strategy"], "BELIEF_PSO_V3")
            self.assertGreater(optimize.call_count, 0)
            self.assertTrue(result.get("diagnostics", {}).get("psoEligible"))

    def test_belief_pso_reacquires_recent_lost_tracks(self):
        tracks = [
            {"id": "T_confirmed", "position": {"x": 4, "y": 12}, "velocity": {"x": 0.2, "y": 1.0}, "confidence": 0.8, "status": "confirmed", "timeSinceUpdate": 2.0, "covariance": [[2, 0], [0, 2]]},
            {"id": "T_recover", "position": {"x": 16, "y": 38}, "velocity": {"x": -0.2, "y": -0.8}, "confidence": 0.3, "status": "lost", "age": 20.0, "timeSinceUpdate": 24.0, "covariance": [[12, 0], [0, 12]]},
            {"id": "T_noise", "position": {"x": 10, "y": 20}, "velocity": {"x": 0, "y": 0}, "confidence": 0.3, "status": "tentative", "timeSinceUpdate": 4.0, "covariance": [[4, 0], [0, 4]]},
        ]
        result = run_strategy("BELIEF_PSO_V2", snapshot(tracks))
        assigned = [target_id for plan in result["plans"] for target_id in plan["assignedTargetIds"]]
        self.assertIn("T_confirmed", assigned)
        self.assertIn("T_recover", assigned)
        self.assertNotIn("T_noise", assigned)

    def test_belief_pso_idle_search_uses_full_sector_skip_scan(self):
        snap = snapshot([])
        result = run_strategy("BELIEF_PSO_V2", snap)
        self.assertTrue(result["plans"])
        for plan in result["plans"]:
            self.assertEqual(plan["action"], "SEARCH_SECTOR")
            self.assertEqual(plan["minLocalAngle"], 0)
            self.assertEqual(plan["maxLocalAngle"], 180)
            self.assertGreater(plan["angularStepDeg"], snap["physics"]["scanStepAngle"])

    def test_belief_pso_ablation_variants_are_explicit_and_bounded(self):
        tracks = [{
            "id": "T1",
            "position": {"x": 4, "y": 12},
            "velocity": {"x": 0.2, "y": 1.0},
            "confidence": 0.8,
            "status": "confirmed",
            "timeSinceUpdate": 4.0,
            "covariance": [[4, 0], [0, 3]],
        }]
        snap = snapshot(tracks)
        for strategy_id in ABLATION_OPTIONS:
            with self.subTest(strategy=strategy_id):
                result = run_strategy(strategy_id, snap)
                self.assertEqual(result["strategy"], strategy_id)
                self.assertEqual(len(result["plans"]), len(snap["sonars"]))
                self.assertTrue(all(0 <= p["minLocalAngle"] < p["maxLocalAngle"] <= 180 for p in result["plans"]))

        fixed = run_strategy("BELIEF_PSO_FIXED_RANGE", snap)
        tracked = [p for p in fixed["plans"] if p["action"] == "TRACK_ROI"]
        self.assertTrue(tracked)
        self.assertTrue(all(p["range"] == snap["physics"]["maxRange"] for p in tracked))

        nearest = _optimize_assignments(snap, tracks, ABLATION_OPTIONS["BELIEF_PSO_NO_PSO"])
        expected = [min(
            _eligible_sonars(snap, track),
            key=lambda index: ((snap["sonars"][index]["position"]["x"] - track["position"]["x"]) ** 2 + (snap["sonars"][index]["position"]["y"] - track["position"]["y"]) ** 2),
        ) for track in tracks]
        self.assertEqual(nearest, expected)

    def test_belief_pso_v3_ablation_variants_are_explicit_and_bounded(self):
        tracks = [{
            "id": "T1",
            "position": {"x": 4, "y": 12},
            "velocity": {"x": 0.2, "y": 1.0},
            "confidence": 0.8,
            "status": "confirmed",
            "timeSinceUpdate": 4.0,
            "covariance": [[4, 0], [0, 3]],
        }]
        snap = snapshot(tracks)
        for strategy_id in proposed_v3.ABLATION_OPTIONS:
            with self.subTest(strategy=strategy_id):
                result = run_strategy(strategy_id, snap)
                self.assertEqual(result["strategy"], strategy_id)
                self.assertEqual(len(result["plans"]), len(snap["sonars"]))
                self.assertTrue(all(0 <= p["minLocalAngle"] < p["maxLocalAngle"] <= 180 for p in result["plans"]))

        fixed = run_strategy("BELIEF_PSO_V3_FIXED_RANGE", snap)
        tracked = [p for p in fixed["plans"] if p["action"] == "TRACK_ROI"]
        self.assertTrue(tracked)
        self.assertTrue(all(p["range"] == snap["physics"]["maxRange"] for p in tracked))


if __name__ == "__main__":
    unittest.main()
