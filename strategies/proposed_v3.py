"""Belief- and coverage-aware multi-sonar scan scheduling with constrained PSO.

The optimizer never reads simulator truth. It treats every confirmed Kalman
track as a belief target, uses deterministic schedulers only as warm-start
particles, repairs decoded particles into feasible sonar-track assignments, and
then builds covariance-aware ROIs plus coverage search commands.
"""

from __future__ import annotations

import math
import random

from .common import clamp, decision, distance, full_scan_plan, relative_sector_angle

STRATEGY_ID = "BELIEF_PSO_V3"
SWARM_SIZE = 32
ITERATIONS = 30
MIN_ROI_DEG = 20.0
MAX_ROI_DEG = 85.0
SEARCH_SWEEP_DEG = 90.0
SEARCH_SKIP_STEP_DEG = 2.4
TRACK_ROI_STEP_DEG = 0.9
SEGMENTED_GROUP_THRESHOLD_DEG = 45.0
SEGMENT_WINDOW_MIN_DEG = 16.0
SEGMENT_WINDOW_MAX_DEG = 42.0
SEGMENT_MERGE_GAP_DEG = 5.0
RANGE_MARGIN_M = 5.0
ANGULAR_SIGMA_MULTIPLIER = 1.35
MAX_ANGULAR_MARGIN_DEG = 26.0
RANGE_SIGMA_MULTIPLIER = 1.25
PRIMARY_GROUP_WIDTH_PENALTY_DEG = 55.0
CONSTRAINED_TARGET_ROI_DEG = 42.0
CONSTRAINED_MAX_REVISIT_SEC = 6.0
CONSTRAINED_HARD_COST = 1_000.0
SEED_CHANGE_BASE_COST = 18.0
SEED_CHANGE_LATERAL_COST = 8.0
TENTATIVE_RECOVERY_ENABLED = False
TENTATIVE_RECOVERY_CONFIDENCE = 0.98
TENTATIVE_RECOVERY_MIN_AGE_SEC = 8.0
TENTATIVE_RECOVERY_MIN_STALENESS_SEC = 2.0
TENTATIVE_RECOVERY_MAX_STALENESS_SEC = 8.0
LOST_RECOVERY_CONFIDENCE = 0.16
LOST_RECOVERY_MAX_STALENESS_SEC = 35.0
MAX_TRACKS_PER_AVAILABLE_SONAR = 2.5
TRACK_LOOKAHEAD_MAX_SEC = 5.5
RECOVERY_LOOKAHEAD_MAX_SEC = 7.0

DEFAULT_OPTIONS = {
    "coverage_debt": True,
    "uncertainty": True,
    "adaptive_range": True,
    "pso": True,
    "constrained_pso": True,
    "redundant_tracking": True,
    "reserve_search": True,
}

ABLATION_OPTIONS = {
    "BELIEF_PSO_V3_NO_COVERAGE": {**DEFAULT_OPTIONS, "coverage_debt": False},
    "BELIEF_PSO_V3_NO_UNCERTAINTY": {**DEFAULT_OPTIONS, "uncertainty": False},
    "BELIEF_PSO_V3_FIXED_RANGE": {**DEFAULT_OPTIONS, "adaptive_range": False},
    "BELIEF_PSO_V3_NO_PSO": {**DEFAULT_OPTIONS, "pso": False},
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": {**DEFAULT_OPTIONS, "constrained_pso": False},
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": {**DEFAULT_OPTIONS, "redundant_tracking": False},
    "BELIEF_PSO_V3_NO_RESERVE_SEARCH": {**DEFAULT_OPTIONS, "reserve_search": False},
}


def _eligible_tracks(snapshot: dict) -> list[dict]:
    return [
        track for track in snapshot.get("tracks", [])
        if track.get("status") == "confirmed" and track.get("confidence", 0.0) >= 0.25
    ]


def _is_recovery_track(track: dict) -> bool:
    confidence = track.get("confidence", 0.0)
    staleness = track.get("timeSinceUpdate", 0.0)
    status = track.get("status")
    if status == "lost":
        return confidence >= LOST_RECOVERY_CONFIDENCE and staleness <= LOST_RECOVERY_MAX_STALENESS_SEC
    if status == "tentative":
        if not TENTATIVE_RECOVERY_ENABLED:
            return False
        track_age = track.get("age", staleness)
        return (
            confidence >= TENTATIVE_RECOVERY_CONFIDENCE
            and track_age >= TENTATIVE_RECOVERY_MIN_AGE_SEC
            and TENTATIVE_RECOVERY_MIN_STALENESS_SEC <= staleness <= TENTATIVE_RECOVERY_MAX_STALENESS_SEC
        )
    return False


def _recovery_tracks(snapshot: dict) -> list[dict]:
    return [track for track in snapshot.get("tracks", []) if _is_recovery_track(track)]


def _is_track_recovery_priority(track: dict) -> bool:
    return (
        track.get("status") != "confirmed"
        or track.get("timeSinceUpdate", 0.0) > 8.0
        or track.get("confidence", 1.0) < 0.35
    )


def _track_status_margin(track: dict) -> float:
    status = track.get("status")
    if status == "lost":
        return 12.0
    if status == "tentative":
        return 6.0
    return 0.0


def _should_use_pso(snapshot: dict, tracks: list[dict], options: dict = DEFAULT_OPTIONS) -> bool:
    if not options.get("pso", False):
        return False
    return len(tracks) > 0


def _pso_diagnostics(
    snapshot: dict,
    tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
) -> dict:
    pso_enabled = bool(options.get("pso", False))
    pso_eligible = _should_use_pso(snapshot, tracks, options)
    if pso_eligible:
        rejection_reason = None
    elif not pso_enabled:
        rejection_reason = "pso_disabled"
    elif not tracks:
        rejection_reason = "no_tracks"
    else:
        rejection_reason = None

    return {
        "psoEnabled": pso_enabled,
        "psoEligible": pso_eligible,
        "psoMode": "constrained_all_tracks",
        "psoAccepted": False,
        "psoChangedAssignment": False,
        "trackCount": len(tracks),
        "sonarCount": len(snapshot["sonars"]),
        "candidateCost": None,
        "fallbackCost": None,
        "seedCost": None,
        "acceptedCostImprovement": None,
        "rejectionReason": rejection_reason,
    }


def _position_sigma(track: dict) -> float:
    covariance = track.get("covariance") or []
    try:
        return math.sqrt(max(0.01, float(covariance[0][0]) + float(covariance[1][1])))
    except (IndexError, TypeError, ValueError):
        return 1.0


def _reflect_axis(position: float, velocity: float, limit: float) -> float:
    if limit <= 0:
        return position
    for _ in range(4):
        if position < 0:
            position = -position
            velocity = -velocity
        elif position > limit:
            position = 2 * limit - position
            velocity = -velocity
        else:
            break
    return clamp(position, 0.0, limit)


def _predict_position(track: dict, horizon_sec: float, pool: dict | None = None) -> dict:
    position = track.get("position", track)
    velocity = track.get("velocity") or {"x": 0.0, "y": 0.0}
    x = position["x"] + velocity.get("x", 0.0) * horizon_sec
    y = position["y"] + velocity.get("y", 0.0) * horizon_sec
    if pool:
        x = _reflect_axis(x, velocity.get("x", 0.0), pool.get("width", 0.0))
        y = _reflect_axis(y, velocity.get("y", 0.0), pool.get("length", 0.0))
    return {
        "x": x,
        "y": y,
    }


def _base_track_horizon(track: dict, recovery: bool = False) -> float:
    age = max(0.0, track.get("timeSinceUpdate", 0.0))
    return clamp(1.0 + 0.30 * age, 1.0, 4.0 if recovery else 2.5)


def _eligible_sonars(snapshot: dict, track: dict) -> list[int]:
    result = []
    predicted = _predict_position(track, 1.0, snapshot.get("pool"))
    for index, sonar in enumerate(snapshot["sonars"]):
        if not sonar.get("available", True):
            continue
        local = relative_sector_angle(sonar, predicted)
        if sonar["minLocalAngle"] <= local <= sonar["maxLocalAngle"]:
            result.append(index)
    if result:
        return result
    return [min(
        range(len(snapshot["sonars"])),
        key=lambda index: distance(snapshot["sonars"][index]["position"], predicted),
    )]


def _scan_beam_interval(snapshot: dict, scan_range: float, angular_step_deg: float | None = None) -> float:
    physics = snapshot["physics"]
    step = max(0.1, angular_step_deg or physics["scanStepAngle"])
    receive_window = max(
        2.0 * scan_range / physics["speedOfSound"],
        physics["samplesPerBeam"] * physics["samplePeriodSec"],
    )
    return (
        receive_window * physics["receiveGuardFactor"]
        + physics["processingOverheadSec"]
        + physics["scanStepOverheadSec"] * step / physics["scanStepAngle"]
    ) * max(1, physics.get("tdmaSlotCount", 1))


def _scan_start_end_for_window(sonar: dict, lo: float, hi: float) -> tuple[float, float]:
    current = sonar["currentLocalAngle"]
    if current < lo or current > hi:
        if abs(current - lo) <= abs(current - hi):
            return lo, hi
        return hi, lo
    if sonar.get("scanDirection", 1) >= 0:
        return current, hi
    return current, lo


def _scan_time_to_angle(
    snapshot: dict,
    sonar: dict,
    lo: float,
    hi: float,
    scan_range: float,
    target_angle: float,
    angular_step_deg: float | None = None,
) -> float:
    physics = snapshot["physics"]
    step = max(0.1, angular_step_deg or physics["scanStepAngle"])
    start, end = _scan_start_end_for_window(sonar, lo, hi)
    path_lo = min(start, end)
    path_hi = max(start, end)
    outside_current_pass = target_angle < path_lo or target_angle > path_hi
    target = clamp(target_angle, path_lo, path_hi)
    reposition = abs(sonar["currentLocalAngle"] - start) / physics["slewSpeed"]
    scan_width_to_target = abs(end - start) if outside_current_pass else abs(target - start)
    beams_to_target = max(1, math.floor(scan_width_to_target / step) + 1)
    return reposition + beams_to_target * _scan_beam_interval(snapshot, scan_range, step)


def _scan_aware_horizon(
    snapshot: dict,
    sonar: dict,
    track: dict,
    lo: float,
    hi: float,
    scan_range: float,
    target_angle: float,
    recovery: bool,
) -> float:
    base = _base_track_horizon(track, recovery)
    scan_time = _scan_time_to_angle(snapshot, sonar, lo, hi, scan_range, target_angle, TRACK_ROI_STEP_DEG)
    limit = RECOVERY_LOOKAHEAD_MAX_SEC if recovery else TRACK_LOOKAHEAD_MAX_SEC
    return clamp(max(base, scan_time), base, limit)


def _roi_geometry(
    snapshot: dict,
    sonar: dict,
    tracks: list[dict],
    max_range: float,
    options: dict = DEFAULT_OPTIONS,
) -> tuple[float, float, float]:
    pool = snapshot.get("pool")
    horizons = [_base_track_horizon(track, _is_track_recovery_priority(track)) for track in tracks]
    lo = sonar["minLocalAngle"]
    hi = sonar["maxLocalAngle"]
    scan_range = max_range

    for _ in range(2):
        predicted = [
            _predict_position(track, horizon, pool)
            for track, horizon in zip(tracks, horizons)
        ]
        local_angles = [relative_sector_angle(sonar, position) for position in predicted]
        angular_margins = []
        for track, position in zip(tracks, predicted):
            target_range = max(0.75, distance(sonar["position"], position))
            sigma = _position_sigma(track) if options["uncertainty"] else 1.0
            sigma_angle = math.degrees(math.atan2(sigma, target_range))
            age_margin = min(8.0, max(0.0, track.get("timeSinceUpdate", 0.0)) * 0.8)
            status_margin = _track_status_margin(track)
            angular_margins.append(clamp(
                6.0 + status_margin + age_margin + ANGULAR_SIGMA_MULTIPLIER * sigma_angle,
                8.0,
                35.0 if status_margin > 0 else MAX_ANGULAR_MARGIN_DEG,
            ))

        raw_lo = min(angle - margin for angle, margin in zip(local_angles, angular_margins))
        raw_hi = max(angle + margin for angle, margin in zip(local_angles, angular_margins))
        center = (raw_lo + raw_hi) / 2.0
        sector_width = sonar["maxLocalAngle"] - sonar["minLocalAngle"]
        width = clamp(raw_hi - raw_lo, MIN_ROI_DEG, min(MAX_ROI_DEG, sector_width))
        lo = clamp(center - width / 2, sonar["minLocalAngle"], sonar["maxLocalAngle"] - width)
        hi = lo + width
        if options["adaptive_range"]:
            target_range = max(
                distance(sonar["position"], position)
                + RANGE_SIGMA_MULTIPLIER * (_position_sigma(track) if options["uncertainty"] else 1.0)
                + RANGE_MARGIN_M
                for track, position in zip(tracks, predicted)
            )
            scan_range = clamp(target_range, 1.0, max_range)
        else:
            scan_range = max_range

        horizons = [
            _scan_aware_horizon(snapshot, sonar, track, lo, hi, scan_range, angle, _is_track_recovery_priority(track))
            for track, angle in zip(tracks, local_angles)
        ]

    return lo, hi, scan_range



def _track_scan_window(
    snapshot: dict,
    sonar: dict,
    track: dict,
    max_range: float,
    options: dict = DEFAULT_OPTIONS,
) -> dict | None:
    age = max(0.0, track.get("timeSinceUpdate", 0.0))
    recovery = _is_track_recovery_priority(track)
    horizon = _base_track_horizon(track, recovery)
    pool = snapshot.get("pool")
    lo = sonar["minLocalAngle"]
    hi = sonar["maxLocalAngle"]
    scan_range = max_range
    angle = lo

    for _ in range(2):
        predicted = _predict_position(track, horizon, pool)
        angle = relative_sector_angle(sonar, predicted)
        if angle < sonar["minLocalAngle"] - 1e-6 or angle > sonar["maxLocalAngle"] + 1e-6:
            return None

        target_range = max(0.75, distance(sonar["position"], predicted))
        sigma = _position_sigma(track) if options["uncertainty"] else 1.0
        sigma_angle = math.degrees(math.atan2(sigma, target_range))
        age_margin = min(20.0 if recovery else 8.0, age * (1.2 if recovery else 0.8))
        status_margin = _track_status_margin(track)
        margin = clamp(
            6.0 + status_margin + age_margin + ANGULAR_SIGMA_MULTIPLIER * sigma_angle,
            10.0 if recovery else 8.0,
            35.0 if recovery else MAX_ANGULAR_MARGIN_DEG,
        )
        width = clamp(2 * margin, SEGMENT_WINDOW_MIN_DEG, SEGMENT_WINDOW_MAX_DEG if not recovery else 70.0)
        lo = clamp(angle - width / 2, sonar["minLocalAngle"], sonar["maxLocalAngle"] - width)
        hi = lo + width

        if options["adaptive_range"]:
            scan_range = target_range + RANGE_SIGMA_MULTIPLIER * sigma + RANGE_MARGIN_M + (6.0 if recovery else 0.0)
        else:
            scan_range = max_range
        scan_range = clamp(scan_range, 1.0, max_range)
        horizon = _scan_aware_horizon(snapshot, sonar, track, lo, hi, scan_range, angle, recovery)

    return {
        "minLocalAngle": lo,
        "maxLocalAngle": hi,
        "range": scan_range,
        "assignedTargetIds": [track["id"]],
    }


def _merge_scan_windows(windows: list[dict]) -> list[dict]:
    if not windows:
        return []
    result = []
    for window in sorted(windows, key=lambda item: (item["minLocalAngle"], item["maxLocalAngle"])):
        if not result or window["minLocalAngle"] > result[-1]["maxLocalAngle"] + SEGMENT_MERGE_GAP_DEG:
            result.append({
                "minLocalAngle": window["minLocalAngle"],
                "maxLocalAngle": window["maxLocalAngle"],
                "range": window["range"],
                "assignedTargetIds": list(window.get("assignedTargetIds", [])),
            })
            continue
        result[-1]["maxLocalAngle"] = max(result[-1]["maxLocalAngle"], window["maxLocalAngle"])
        result[-1]["range"] = max(result[-1]["range"], window["range"])
        seen = set(result[-1].get("assignedTargetIds", []))
        for target_id in window.get("assignedTargetIds", []):
            if target_id not in seen:
                result[-1]["assignedTargetIds"].append(target_id)
                seen.add(target_id)
    return result


def _segmented_roi_plan(
    snapshot: dict,
    sonar: dict,
    tracks: list[dict],
    max_range: float,
    options: dict = DEFAULT_OPTIONS,
) -> dict:
    windows = [
        window for window in (
            _track_scan_window(snapshot, sonar, track, max_range, options)
            for track in tracks
        )
        if window is not None
    ]
    if not windows:
        return full_scan_plan(sonar, max_range)

    merged = _merge_scan_windows(windows)
    spread = max(window["maxLocalAngle"] for window in merged) - min(window["minLocalAngle"] for window in merged)
    needs_segmentation = len(merged) > 1 and spread >= SEGMENTED_GROUP_THRESHOLD_DEG
    if not needs_segmentation:
        lo, hi, scan_range = _roi_geometry(snapshot, sonar, tracks, max_range, options)
        return {
            "sonarId": sonar["id"],
            "minLocalAngle": lo,
            "maxLocalAngle": hi,
            "range": scan_range,
            "angularStepDeg": TRACK_ROI_STEP_DEG,
            "assignedTargetIds": [track["id"] for track in tracks],
            "action": "TRACK_ROI",
        }

    return {
        "sonarId": sonar["id"],
        "minLocalAngle": min(window["minLocalAngle"] for window in merged),
        "maxLocalAngle": max(window["maxLocalAngle"] for window in merged),
        "range": max(window["range"] for window in merged),
        "angularStepDeg": TRACK_ROI_STEP_DEG,
        "assignedTargetIds": [track["id"] for track in tracks],
        "action": "TRACK_ROI",
        "scanWindows": merged,
    }


def _scan_duration(
    snapshot: dict,
    sonar: dict,
    lo: float,
    hi: float,
    scan_range: float,
    angular_step_deg: float | None = None,
) -> float:
    physics = snapshot["physics"]
    step = max(0.1, angular_step_deg or physics["scanStepAngle"])
    beams = max(1, math.floor(abs(hi - lo) / step) + 1)
    receive_window = max(
        2.0 * scan_range / physics["speedOfSound"],
        physics["samplesPerBeam"] * physics["samplePeriodSec"],
    )
    beam_interval = (
        receive_window * physics["receiveGuardFactor"]
        + physics["processingOverheadSec"]
        + physics["scanStepOverheadSec"] * step / physics["scanStepAngle"]
    )
    current = sonar["currentLocalAngle"]
    reposition = min(abs(current - lo), abs(current - hi)) / physics["slewSpeed"]
    return reposition + beams * beam_interval * max(1, physics.get("tdmaSlotCount", 1))


def _track_urgency(track: dict, options: dict = DEFAULT_OPTIONS) -> float:
    age = max(0.0, track.get("timeSinceUpdate", 0.0))
    if not options["uncertainty"]:
        return 1.0 + age / 3.0
    confidence = clamp(track.get("confidence", 0.5), 0.05, 1.0)
    return 1.0 + age / 3.0 + _position_sigma(track) / 2.0 + (1.0 - confidence)


def _assignment_change_risk(track: dict) -> float:
    velocity = track.get("velocity") or {}
    vx = abs(velocity.get("x", 0.0))
    vy = abs(velocity.get("y", 0.0))
    speed = vx + vy
    if speed < 0.2:
        return 0.35
    return vx / speed


def _decode(
    snapshot: dict,
    tracks: list[dict],
    position: list[float],
    options: dict = DEFAULT_OPTIONS,
) -> list[int]:
    assignments = []
    for dim, track in enumerate(tracks):
        eligible = _eligible_sonars(snapshot, track)
        raw = int(round(position[dim])) % len(snapshot["sonars"])
        assignments.append(raw if raw in eligible else min(
            eligible,
            key=lambda index: abs(index - raw),
        ))
    return _repair_assignments(snapshot, tracks, assignments, options)


def _coverage_debt(sonar: dict) -> float:
    bins = sonar.get("coverageBins") or []
    return max((bin_.get("ageSec", 0.0) for bin_ in bins), default=0.0)


def _previous_assignment_sets(snapshot: dict) -> list[set[str]]:
    return [
        set(sonar.get("assignedTargetIds") or [])
        for sonar in snapshot["sonars"]
    ]


def _available_sonar_indexes(snapshot: dict) -> list[int]:
    available = [
        index for index, sonar in enumerate(snapshot["sonars"])
        if sonar.get("available", True)
    ]
    return available or list(range(len(snapshot["sonars"])))


def _primary_assignment_cost(
    snapshot: dict,
    sonar_index: int,
    group: list[dict],
    track: dict,
    previous: list[set[str]],
    options: dict = DEFAULT_OPTIONS,
) -> float:
    sonar = snapshot["sonars"][sonar_index]
    max_range = snapshot["physics"]["maxRange"]
    candidate_group = group + [track]
    lo, hi, scan_range = _roi_geometry(snapshot, sonar, candidate_group, max_range, options)
    duration = _scan_duration(snapshot, sonar, lo, hi, scan_range, TRACK_ROI_STEP_DEG)
    predicted = _predict_position(track, _base_track_horizon(track), snapshot.get("pool"))
    range_penalty = distance(sonar["position"], predicted) / max(1.0, max_range)
    width_penalty = max(0.0, (hi - lo) - PRIMARY_GROUP_WIDTH_PENALTY_DEG) / 10.0
    switch_penalty = 0.0 if track["id"] in previous[sonar_index] else 0.35
    load_penalty = len(group) * 0.8
    return duration + range_penalty + width_penalty + switch_penalty + load_penalty


def _assign_primary_fast(
    snapshot: dict,
    tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
) -> list[list[dict]]:
    sonars = snapshot["sonars"]
    groups: list[list[dict]] = [[] for _ in sonars]
    previous = _previous_assignment_sets(snapshot)
    ordered_tracks = sorted(
        tracks,
        key=lambda track: (-_track_urgency(track, options), track["id"]),
    )

    for track in ordered_tracks:
        eligible = [
            index for index in _eligible_sonars(snapshot, track)
            if sonars[index].get("available", True)
        ]
        if not eligible:
            eligible = _available_sonar_indexes(snapshot)
        best = min(
            eligible,
            key=lambda index: _primary_assignment_cost(
                snapshot,
                index,
                groups[index],
                track,
                previous,
                options,
            ),
        )
        groups[best].append(track)

    return groups


def _groups_from_assignments(
    snapshot: dict,
    tracks: list[dict],
    assignments: list[int],
) -> list[list[dict]]:
    groups: list[list[dict]] = [[] for _ in snapshot["sonars"]]
    for track, sonar_index in zip(tracks, assignments):
        if 0 <= sonar_index < len(groups):
            groups[sonar_index].append(track)
    return groups


def _assignments_from_groups(groups: list[list[dict]], tracks: list[dict]) -> list[int]:
    by_track_id = {
        track["id"]: sonar_index
        for sonar_index, group in enumerate(groups)
        for track in group
    }
    return [by_track_id.get(track["id"], 0) for track in tracks]


def _repair_move_score(
    snapshot: dict,
    groups: list[list[dict]],
    source_index: int,
    target_index: int,
    track: dict,
    previous: list[set[str]],
    options: dict = DEFAULT_OPTIONS,
) -> float:
    source_after = [item for item in groups[source_index] if item["id"] != track["id"]]
    target_after = groups[target_index] + [track]
    score = _primary_assignment_cost(snapshot, target_index, groups[target_index], track, previous, options)
    score += 0.15 * max(0, len(target_after) - len(source_after))
    score -= 0.20 * max(0, len(groups[source_index]) - len(groups[target_index]))
    return score


def _move_track_between_groups(
    groups: list[list[dict]],
    assignments_by_id: dict[str, int],
    track: dict,
    source_index: int,
    target_index: int,
) -> None:
    groups[source_index] = [item for item in groups[source_index] if item["id"] != track["id"]]
    groups[target_index].append(track)
    assignments_by_id[track["id"]] = target_index


def _repair_assignments(
    snapshot: dict,
    tracks: list[dict],
    assignments: list[int],
    options: dict = DEFAULT_OPTIONS,
) -> list[int]:
    if not tracks:
        return []

    sonars = snapshot["sonars"]
    available = _available_sonar_indexes(snapshot)
    previous = _previous_assignment_sets(snapshot)
    corrected: list[int] = []
    for track, assignment in zip(tracks, assignments):
        eligible = [
            index for index in _eligible_sonars(snapshot, track)
            if index in available and sonars[index].get("available", True)
        ]
        if not eligible:
            eligible = _eligible_sonars(snapshot, track)
        corrected.append(assignment if assignment in eligible else min(
            eligible,
            key=lambda index: distance(
                sonars[index]["position"],
                _predict_position(track, _base_track_horizon(track), snapshot.get("pool")),
            ),
        ))

    groups = _groups_from_assignments(snapshot, tracks, corrected)
    assignments_by_id = {track["id"]: sonar_index for track, sonar_index in zip(tracks, corrected)}
    if not available:
        return [assignments_by_id[track["id"]] for track in tracks]
    if not options.get("constrained_pso", True):
        return corrected

    target_min = 1 if len(tracks) > len(available) else 0
    target_max = max(1, math.ceil(len(tracks) / max(1, len(available))))

    # Feasibility repair: when there are more targets than sonars,
    # keep every available sonar active unless visibility constraints forbid it.
    for empty_index in [index for index in available if len(groups[index]) < target_min]:
        candidates = []
        for source_index in available:
            if source_index == empty_index or len(groups[source_index]) <= target_min:
                continue
            for track in groups[source_index]:
                if empty_index not in _eligible_sonars(snapshot, track):
                    continue
                candidates.append((
                    _repair_move_score(snapshot, groups, source_index, empty_index, track, previous, options),
                    source_index,
                    track,
                ))
        if not candidates:
            continue
        _, source_index, track = min(candidates, key=lambda item: (item[0], item[2]["id"]))
        _move_track_between_groups(groups, assignments_by_id, track, source_index, empty_index)

    # Capacity repair: avoid PSO collapsing too many swimmers into one wide ROI
    # only in genuinely overloaded scenes. For smaller scenes, retaining the
    # warm-start geometry is usually more important for identity stability.
    if len(tracks) <= len(available):
        return [assignments_by_id[track["id"]] for track in tracks]

    changed = True
    while changed:
        changed = False
        overloaded = [
            index for index in available
            if len(groups[index]) > target_max
        ]
        underloaded = [
            index for index in available
            if len(groups[index]) < target_max
        ]
        if not overloaded or not underloaded:
            break
        candidates = []
        for source_index in overloaded:
            for track in groups[source_index]:
                for target_index in underloaded:
                    if source_index == target_index or target_index not in _eligible_sonars(snapshot, track):
                        continue
                    candidates.append((
                        _repair_move_score(snapshot, groups, source_index, target_index, track, previous, options),
                        source_index,
                        target_index,
                        track,
                    ))
        if not candidates:
            break
        _, source_index, target_index, track = min(candidates, key=lambda item: (item[0], item[3]["id"]))
        _move_track_between_groups(groups, assignments_by_id, track, source_index, target_index)
        changed = True

    return [assignments_by_id[track["id"]] for track in tracks]


def _best_redundant_track_for_sonar(
    snapshot: dict,
    sonar_index: int,
    tracks: list[dict],
    duplicate_counts: dict[str, int],
    options: dict = DEFAULT_OPTIONS,
) -> dict | None:
    sonar = snapshot["sonars"][sonar_index]
    max_range = snapshot["physics"]["maxRange"]
    previous = set(sonar.get("assignedTargetIds") or [])
    candidates = [
        track for track in tracks
        if sonar_index in _eligible_sonars(snapshot, track)
    ] or tracks
    if not candidates:
        return None

    def score(track: dict) -> tuple[float, float, str]:
        predicted = _predict_position(track, _base_track_horizon(track), snapshot.get("pool"))
        duplicates = duplicate_counts.get(track["id"], 0)
        stickiness = 0.35 if track["id"] in previous else 0.0
        urgency = _track_urgency(track, options)
        range_term = distance(sonar["position"], predicted) / max(1.0, max_range)
        return (
            urgency / (1.0 + duplicates * 1.7) + stickiness - range_term,
            -range_term,
            track["id"],
        )

    return max(candidates, key=score)


def _reserve_search_index(snapshot: dict, candidates: list[int]) -> int | None:
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda index: (
            _coverage_debt(snapshot["sonars"][index]),
            -abs(snapshot["sonars"][index]["currentLocalAngle"] - 90.0),
        ),
    )


def _best_recovery_track_for_sonar(
    snapshot: dict,
    sonar_index: int,
    recovery_tracks: list[dict],
    assigned_recovery_ids: set[str],
    options: dict = DEFAULT_OPTIONS,
) -> dict | None:
    if not recovery_tracks:
        return None
    sonar = snapshot["sonars"][sonar_index]
    max_range = snapshot["physics"]["maxRange"]
    previous = set(sonar.get("assignedTargetIds") or [])
    candidates = [
        track for track in recovery_tracks
        if track["id"] not in assigned_recovery_ids
        and sonar_index in _eligible_sonars(snapshot, track)
    ]
    if not candidates:
        candidates = [
            track for track in recovery_tracks
            if track["id"] not in assigned_recovery_ids
        ]
    if not candidates:
        return None

    def score(track: dict) -> tuple[float, float, str]:
        predicted = _predict_position(track, _base_track_horizon(track, True), snapshot.get("pool"))
        range_term = distance(sonar["position"], predicted) / max(1.0, max_range)
        stickiness = 0.35 if track["id"] in previous else 0.0
        return (
            _track_urgency(track, options) + stickiness - range_term,
            -range_term,
            track["id"],
        )

    return max(candidates, key=score)


def _add_recovery_tracking(
    snapshot: dict,
    groups: list[list[dict]],
    recovery_tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
) -> set[int]:
    if not recovery_tracks:
        return set()

    available = _available_sonar_indexes(snapshot)
    empty = [index for index in available if not groups[index]]
    if not empty:
        return set()

    reserved_for_search: set[int] = set()
    if options.get("reserve_search", True) and len(empty) > 1:
        reserve = _reserve_search_index(snapshot, empty)
        if reserve is not None:
            reserved_for_search.add(reserve)

    assigned_recovery_ids: set[str] = set()
    usable_empty = [index for index in empty if index not in reserved_for_search]
    per_run_limit = max(1, math.ceil(len(available) * MAX_TRACKS_PER_AVAILABLE_SONAR) - sum(len(group) for group in groups))
    for sonar_index in usable_empty[:per_run_limit]:
        track = _best_recovery_track_for_sonar(
            snapshot,
            sonar_index,
            recovery_tracks,
            assigned_recovery_ids,
            options,
        )
        if track is None:
            continue
        groups[sonar_index].append(track)
        assigned_recovery_ids.add(track["id"])

    return reserved_for_search


def _add_redundant_tracking(
    snapshot: dict,
    groups: list[list[dict]],
    tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
) -> set[int]:
    if not tracks or not options.get("redundant_tracking", True):
        return set()

    available = _available_sonar_indexes(snapshot)
    empty = [index for index in available if not groups[index]]
    reserved_for_search: set[int] = set()
    if not empty:
        return reserved_for_search

    if options.get("reserve_search", True) and options.get("coverage_debt", True):
        reserve = max(
            empty,
            key=lambda index: (
                _coverage_debt(snapshot["sonars"][index]),
                -abs(snapshot["sonars"][index]["currentLocalAngle"] - 90.0),
            ),
        )
        reserved_for_search.add(reserve)
        empty = [index for index in empty if index != reserve]

    duplicate_counts: dict[str, int] = {}
    for group in groups:
        for track in group:
            duplicate_counts[track["id"]] = duplicate_counts.get(track["id"], 0) + 1

    for sonar_index in empty:
        track = _best_redundant_track_for_sonar(
            snapshot,
            sonar_index,
            tracks,
            duplicate_counts,
            options,
        )
        if track is None:
            continue
        groups[sonar_index].append(track)
        duplicate_counts[track["id"]] = duplicate_counts.get(track["id"], 0) + 1

    return reserved_for_search


def _assignment_cost(
    snapshot: dict,
    tracks: list[dict],
    assignments: list[int],
    options: dict = DEFAULT_OPTIONS,
) -> float:
    sonars = snapshot["sonars"]
    max_range = snapshot["physics"]["maxRange"]
    available = _available_sonar_indexes(snapshot)
    overloaded = len(tracks) > len(available)
    constrained = options.get("constrained_pso", True)
    target_min = 1 if constrained and overloaded else 0
    target_max = max(1, math.ceil(len(tracks) / max(1, len(available))))
    groups = [[] for _ in sonars]
    for track, sonar_index in zip(tracks, assignments):
        groups[sonar_index].append(track)

    durations = [0.0 for _ in sonars]
    predicted_revisit_ages = []
    cost = 0.0
    for index, group in enumerate(groups):
        sonar = sonars[index]
        if not group:
            if constrained and index in available and target_min > 0:
                cost += CONSTRAINED_HARD_COST
            if options["coverage_debt"]:
                if overloaded:
                    cost += 4.0
                else:
                    cost -= min(12.0, _coverage_debt(sonar)) * 0.03
            continue
        lo, hi, scan_range = _roi_geometry(snapshot, sonar, group, max_range, options)
        duration = _scan_duration(snapshot, sonar, lo, hi, scan_range, TRACK_ROI_STEP_DEG)
        durations[index] = duration
        previous = set(sonar.get("assignedTargetIds") or [])
        current = {track["id"] for track in group}
        width = hi - lo
        excess_capacity = max(0, len(group) - target_max) if constrained and overloaded else 0
        switch_cost = len(previous.symmetric_difference(current)) * 2.0
        multi_track_penalty = max(0, len(group) - 1) * 1.6 + excess_capacity * excess_capacity * CONSTRAINED_HARD_COST
        width_penalty = (
            max(0.0, width - CONSTRAINED_TARGET_ROI_DEG) / 2.0
            + max(0.0, width - PRIMARY_GROUP_WIDTH_PENALTY_DEG) ** 2 / 24.0
        )
        cost += switch_cost + duration * (0.62 + 0.18 * len(group)) + multi_track_penalty + width_penalty
        for track in group:
            predicted = _predict_position(track, duration, snapshot.get("pool"))
            normalized_range = distance(sonar["position"], predicted) / max_range
            predicted_revisit_age = track.get("timeSinceUpdate", 0.0) + duration
            predicted_revisit_ages.append(predicted_revisit_age)
            cost += 1.2 * _track_urgency(track, options) * predicted_revisit_age
            cost += 0.65 * predicted_revisit_age * predicted_revisit_age
            if constrained:
                cost += 3.0 * max(0.0, predicted_revisit_age - CONSTRAINED_MAX_REVISIT_SEC) ** 2
            cost += normalized_range * 1.2

    mean_duration = sum(durations) / max(1, len(durations))
    load_variance = sum((duration - mean_duration) ** 2 for duration in durations) / max(1, len(durations))
    max_duration = max(durations, default=0.0)
    global_debt = sum(_coverage_debt(sonar) for sonar in sonars) / max(1, len(sonars))
    idle_count = sum(1 for group in groups if not group)
    cost += 0.60 * max_duration + 0.18 * load_variance
    if predicted_revisit_ages:
        mean_revisit = sum(predicted_revisit_ages) / len(predicted_revisit_ages)
        revisit_variance = sum((age - mean_revisit) ** 2 for age in predicted_revisit_ages) / len(predicted_revisit_ages)
        max_revisit = max(predicted_revisit_ages)
        cost += 0.85 * max_revisit * max_revisit + 0.40 * revisit_variance
        if constrained:
            cost += 5.0 * max(0.0, max_revisit - CONSTRAINED_MAX_REVISIT_SEC) ** 2
    if constrained and overloaded:
        cost += idle_count * CONSTRAINED_HARD_COST
    if options["coverage_debt"]:
        cost += global_debt * (0.08 if idle_count == 0 else 0.02)
    return cost


def _regularized_assignment_cost(
    snapshot: dict,
    tracks: list[dict],
    assignments: list[int],
    reference_assignments: list[int] | None,
    options: dict = DEFAULT_OPTIONS,
) -> float:
    cost = _assignment_cost(snapshot, tracks, assignments, options)
    if not reference_assignments:
        return cost
    for track, assignment, reference in zip(tracks, assignments, reference_assignments):
        if assignment == reference:
            continue
        cost += SEED_CHANGE_BASE_COST
        cost += SEED_CHANGE_LATERAL_COST * _assignment_change_risk(track)
        cost += 1.8 * _track_urgency(track, options)
        cost += 0.8 * max(0.0, track.get("timeSinceUpdate", 0.0))
    return cost


def _nearest_assignments(snapshot: dict, tracks: list[dict]) -> list[int]:
    return [min(
        _eligible_sonars(snapshot, track),
        key=lambda index: distance(snapshot["sonars"][index]["position"], track["position"]),
    ) for track in tracks]


def _optimize_assignments(
    snapshot: dict,
    tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
    return_diagnostics: bool = False,
) -> list[int] | tuple[list[int], dict]:
    assignments, diagnostics = _optimize_assignments_with_diagnostics(snapshot, tracks, options)
    if return_diagnostics:
        return assignments, diagnostics
    return assignments


def _optimize_assignments_with_diagnostics(
    snapshot: dict,
    tracks: list[dict],
    options: dict = DEFAULT_OPTIONS,
) -> tuple[list[int], dict]:
    if not tracks:
        return [], {
            "psoAccepted": False,
            "psoChangedAssignment": False,
            "candidateCost": None,
            "fallbackCost": None,
            "acceptedCostImprovement": None,
            "rejectionReason": "no_tracks",
        }
    if not options["pso"]:
        nearest_assignments = _nearest_assignments(snapshot, tracks)
        return nearest_assignments, {
            "psoAccepted": False,
            "psoChangedAssignment": False,
            "candidateCost": None,
            "fallbackCost": _assignment_cost(snapshot, tracks, nearest_assignments, options),
            "acceptedCostImprovement": None,
            "rejectionReason": "pso_disabled",
        }
    sonar_count = len(snapshot["sonars"])
    seed = int(snapshot.get("seed", 0)) ^ int(snapshot.get("simulationTime", 0.0) * 1000) ^ len(tracks) * 7919
    rng = random.Random(seed)
    dimensions = len(tracks)
    fast_assignments = _repair_assignments(snapshot, tracks, _assignments_from_groups(
        _assign_primary_fast(snapshot, tracks, options),
        tracks,
    ), options)
    nearest_assignments = _repair_assignments(snapshot, tracks, _nearest_assignments(snapshot, tracks), options)

    positions = [[rng.uniform(0, sonar_count - 1) for _ in range(dimensions)] for _ in range(SWARM_SIZE)]
    velocities = [[rng.uniform(-1, 1) for _ in range(dimensions)] for _ in range(SWARM_SIZE)]
    # Seed strong, interpretable particles so PSO is an improvement step over
    # the deterministic scheduler, not a completely separate assignment policy.
    positions[0] = [float(index) for index in fast_assignments]
    if SWARM_SIZE > 1:
        positions[1] = [float(index) for index in nearest_assignments]

    personal_best = [list(position) for position in positions]
    personal_cost = [
        _regularized_assignment_cost(
            snapshot,
            tracks,
            _decode(snapshot, tracks, position, options),
            fast_assignments,
            options,
        )
        for position in positions
    ]
    best_index = min(range(SWARM_SIZE), key=lambda index: personal_cost[index])
    global_best = list(personal_best[best_index])
    global_cost = personal_cost[best_index]

    for _ in range(ITERATIONS):
        for particle in range(SWARM_SIZE):
            for dim in range(dimensions):
                velocities[particle][dim] = (
                    0.65 * velocities[particle][dim]
                    + 1.4 * rng.random() * (personal_best[particle][dim] - positions[particle][dim])
                    + 1.6 * rng.random() * (global_best[dim] - positions[particle][dim])
                )
                positions[particle][dim] = clamp(
                    positions[particle][dim] + velocities[particle][dim],
                    0.0,
                    float(sonar_count - 1),
                )
            cost = _regularized_assignment_cost(
                snapshot,
                tracks,
                _decode(snapshot, tracks, positions[particle], options),
                fast_assignments,
                options,
            )
            if cost < personal_cost[particle]:
                personal_cost[particle] = cost
                personal_best[particle] = list(positions[particle])
            if cost < global_cost:
                global_cost = cost
                global_best = list(positions[particle])

    candidate = _decode(snapshot, tracks, global_best, options)
    candidate_cost = _regularized_assignment_cost(snapshot, tracks, candidate, fast_assignments, options)
    fast_cost = _regularized_assignment_cost(snapshot, tracks, fast_assignments, fast_assignments, options)
    return candidate, {
        "psoAccepted": True,
        "psoChangedAssignment": candidate != fast_assignments,
        "candidateCost": candidate_cost,
        "fallbackCost": fast_cost,
        "seedCost": fast_cost,
        "acceptedCostImprovement": fast_cost - candidate_cost,
        "rejectionReason": None,
    }


def _search_plan(
    sonar: dict,
    sonar_index: int,
    snapshot: dict,
    recovery_tracks: list[dict] | None = None,
    options: dict = DEFAULT_OPTIONS,
) -> dict:
    if not sonar.get("available", True):
        return {
            "sonarId": sonar["id"],
            "minLocalAngle": sonar["currentLocalAngle"],
            "maxLocalAngle": min(sonar["maxLocalAngle"], sonar["currentLocalAngle"] + 1.0),
            "range": 1.0,
            "assignedTargetIds": [],
            "action": "IDLE",
        }

    return {
        "sonarId": sonar["id"],
        "minLocalAngle": sonar["minLocalAngle"],
        "maxLocalAngle": sonar["maxLocalAngle"],
        "range": snapshot["physics"]["maxRange"],
        "angularStepDeg": SEARCH_SKIP_STEP_DEG,
        "assignedTargetIds": [],
        "action": "SEARCH_SECTOR",
    }


def _plan_with_options(snapshot: dict, strategy_id: str, options: dict) -> dict:
    sonars = snapshot["sonars"]
    tracks = _eligible_tracks(snapshot)
    recovery_tracks = _recovery_tracks(snapshot)
    diagnostics = _pso_diagnostics(snapshot, tracks, options)
    if diagnostics["psoEligible"]:
        assignments, optimizer_diagnostics = _optimize_assignments(
            snapshot,
            tracks,
            options,
            return_diagnostics=True,
        )
        diagnostics.update(optimizer_diagnostics)
        groups = _groups_from_assignments(
            snapshot,
            tracks,
            assignments,
        )
    else:
        groups = _assign_primary_fast(snapshot, tracks, options)
        if tracks:
            fast_assignments = _assignments_from_groups(groups, tracks)
            diagnostics["fallbackCost"] = _assignment_cost(snapshot, tracks, fast_assignments, options)
    assigned_primary_ids = {track["id"] for group in groups for track in group}
    recovery_tracks = [
        track for track in recovery_tracks
        if track["id"] not in assigned_primary_ids
    ]
    _add_recovery_tracking(snapshot, groups, recovery_tracks, options)
    _add_redundant_tracking(snapshot, groups, tracks, options)

    plans = []
    max_range = snapshot["physics"]["maxRange"]
    for index, sonar in enumerate(sonars):
        if not groups[index]:
            plans.append(_search_plan(sonar, index, snapshot, recovery_tracks, options))
            continue
        plans.append(_segmented_roi_plan(snapshot, sonar, groups[index], max_range, options))
    result = decision(strategy_id, snapshot, plans)
    result["diagnostics"] = diagnostics
    return result


def plan(snapshot: dict) -> dict:
    return _plan_with_options(snapshot, STRATEGY_ID, DEFAULT_OPTIONS)


def plan_no_coverage(snapshot: dict) -> dict:
    return _plan_with_options(snapshot, "BELIEF_PSO_V3_NO_COVERAGE", ABLATION_OPTIONS["BELIEF_PSO_V3_NO_COVERAGE"])


def plan_no_uncertainty(snapshot: dict) -> dict:
    return _plan_with_options(snapshot, "BELIEF_PSO_V3_NO_UNCERTAINTY", ABLATION_OPTIONS["BELIEF_PSO_V3_NO_UNCERTAINTY"])


def plan_fixed_range(snapshot: dict) -> dict:
    return _plan_with_options(snapshot, "BELIEF_PSO_V3_FIXED_RANGE", ABLATION_OPTIONS["BELIEF_PSO_V3_FIXED_RANGE"])


def plan_no_pso(snapshot: dict) -> dict:
    return _plan_with_options(snapshot, "BELIEF_PSO_V3_NO_PSO", ABLATION_OPTIONS["BELIEF_PSO_V3_NO_PSO"])


def plan_no_constrained_repair(snapshot: dict) -> dict:
    return _plan_with_options(
        snapshot,
        "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR",
        ABLATION_OPTIONS["BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR"],
    )


def plan_no_redundant_tracking(snapshot: dict) -> dict:
    return _plan_with_options(
        snapshot,
        "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING",
        ABLATION_OPTIONS["BELIEF_PSO_V3_NO_REDUNDANT_TRACKING"],
    )


def plan_no_reserve_search(snapshot: dict) -> dict:
    return _plan_with_options(
        snapshot,
        "BELIEF_PSO_V3_NO_RESERVE_SEARCH",
        ABLATION_OPTIONS["BELIEF_PSO_V3_NO_RESERVE_SEARCH"],
    )
