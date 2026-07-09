import math

from .common import clamp, decision, distance, full_scan_plan, relative_sector_angle

TARGET_PADDING_ANGLE = 25
TARGET_PADDING_RANGE_M = 5
MIN_SWEEP_DEG = 20


def _eligible_sonar_indexes(sonars: list[dict], track_pos: dict) -> list[int]:
    eligible = [i for i, sonar in enumerate(sonars) if sonar.get("available", True) and relative_sector_angle(sonar, track_pos) <= sonar["maxLocalAngle"]]
    if eligible:
        return eligible
    available = [i for i, sonar in enumerate(sonars) if sonar.get("available", True)]
    nearest = min(available or list(range(len(sonars))), key=lambda i: distance(sonars[i]["position"], track_pos))
    return [nearest]


def _roi_plan(sonar: dict, tracks: list[dict], max_range: float) -> dict:
    if not tracks:
        return full_scan_plan(sonar, max_range)

    rel_angles = [a for t in tracks if (a := relative_sector_angle(sonar, t.get("position", t))) <= sonar["maxLocalAngle"]]
    if not rel_angles:
        return full_scan_plan(sonar, max_range)

    min_rel = clamp(min(rel_angles) - TARGET_PADDING_ANGLE, sonar["minLocalAngle"], sonar["maxLocalAngle"])
    max_rel = clamp(max(rel_angles) + TARGET_PADDING_ANGLE, sonar["minLocalAngle"], sonar["maxLocalAngle"])
    if max_rel - min_rel < MIN_SWEEP_DEG:
        center = (min_rel + max_rel) / 2
        min_rel = center - MIN_SWEEP_DEG / 2
        max_rel = center + MIN_SWEEP_DEG / 2
        if min_rel < sonar["minLocalAngle"]:
            max_rel += sonar["minLocalAngle"] - min_rel
            min_rel = sonar["minLocalAngle"]
        if max_rel > sonar["maxLocalAngle"]:
            min_rel -= max_rel - sonar["maxLocalAngle"]
            max_rel = sonar["maxLocalAngle"]

    rng = max(distance(sonar["position"], t.get("position", t)) for t in tracks) + TARGET_PADDING_RANGE_M

    return {
        "sonarId": sonar["id"],
        "minLocalAngle": clamp(min_rel, sonar["minLocalAngle"], sonar["maxLocalAngle"]),
        "maxLocalAngle": clamp(max_rel, sonar["minLocalAngle"], sonar["maxLocalAngle"]),
        "range": clamp(rng, 1, max_range),
        "assignedTargetIds": [t["id"] for t in tracks],
        "action": "TRACK_ROI",
    }


def plan_nearest_roi(snapshot: dict) -> dict:
    max_range = snapshot["physics"]["maxRange"]
    sonars = snapshot["sonars"]
    groups = [[] for _ in sonars]
    for track in snapshot.get("tracks", []):
        track_pos = track.get("position", track)
        eligible = _eligible_sonar_indexes(sonars, track_pos)
        best = min(eligible, key=lambda i: distance(sonars[i]["position"], track_pos))
        groups[best].append(track)
    plans = [_roi_plan(sonars[i], groups[i], max_range) for i in range(len(sonars))]
    return decision("NEAREST_ROI", snapshot, plans)


def plan_round_robin_roi(snapshot: dict) -> dict:
    max_range = snapshot["physics"]["maxRange"]
    sonars = snapshot["sonars"]
    groups = [[] for _ in sonars]
    if not sonars:
        return decision("ROUND_ROBIN_ROI", snapshot, plans=[])
    bucket = int(snapshot["simulationTime"] / 5)
    tracks = sorted(snapshot.get("tracks", []), key=lambda track: track.get("id", ""))
    for offset, track in enumerate(tracks):
        track_pos = track.get("position", track)
        eligible = _eligible_sonar_indexes(sonars, track_pos)
        preferred = (bucket + offset) % len(sonars)
        best = preferred if preferred in eligible else eligible[offset % len(eligible)]
        groups[best].append(track)
    plans = [_roi_plan(sonars[i], groups[i], max_range) for i in range(len(sonars))]
    return decision("ROUND_ROBIN_ROI", snapshot, plans)


def plan_max_aoi_greedy(snapshot: dict) -> dict:
    max_range = snapshot["physics"]["maxRange"]
    sonars = snapshot["sonars"]
    groups = [[] for _ in sonars]
    tracks = sorted(snapshot.get("tracks", []), key=lambda t: -(t.get("timeSinceUpdate", 0)))
    for track in tracks:
        track_pos = track.get("position", track)
        eligible = _eligible_sonar_indexes(sonars, track_pos)
        best = min(eligible, key=lambda i: (len(groups[i]), distance(sonars[i]["position"], track_pos)))
        groups[best].append(track)
    plans = [_roi_plan(sonars[i], groups[i], max_range) for i in range(len(sonars))]
    return decision("MAX_AOI_GREEDY", snapshot, plans)


def _uncertainty(track: dict) -> float:
    covariance = track.get("covariance") or []
    try:
        trace = max(0.0, covariance[0][0]) + max(0.0, covariance[1][1])
    except (IndexError, TypeError):
        trace = 1.0
    return trace + 0.5 * track.get("timeSinceUpdate", 0.0) + 2.0 * (1.0 - track.get("confidence", 0.5))


def plan_uncertainty_greedy(snapshot: dict) -> dict:
    max_range = snapshot["physics"]["maxRange"]
    sonars = snapshot["sonars"]
    groups = [[] for _ in sonars]
    for track in sorted(snapshot.get("tracks", []), key=_uncertainty, reverse=True):
        position = track.get("position", track)
        eligible = _eligible_sonar_indexes(sonars, position)
        best = min(eligible, key=lambda index: (len(groups[index]), distance(sonars[index]["position"], position)))
        groups[best].append(track)
    return decision("UNCERTAINTY_GREEDY", snapshot, [
        _roi_plan(sonars[index], groups[index], max_range) for index in range(len(sonars))
    ])


def plan_round_robin_sector(snapshot: dict) -> dict:
    sector_width = 30.0
    sector_count = 6
    bucket = int(snapshot["simulationTime"] / 2.5)
    plans = []
    for index, sonar in enumerate(snapshot["sonars"]):
        if not sonar.get("available", True):
            plans.append(full_scan_plan(sonar, snapshot["physics"]["maxRange"]))
            continue
        sector = (bucket + index * 2) % sector_count
        lo = sonar["minLocalAngle"] + sector * sector_width
        plans.append({
            "sonarId": sonar["id"],
            "minLocalAngle": lo,
            "maxLocalAngle": min(sonar["maxLocalAngle"], lo + sector_width),
            "range": snapshot["physics"]["maxRange"],
            "assignedTargetIds": [],
            "action": "SEARCH_SECTOR",
        })
    return decision("ROUND_ROBIN_SECTOR", snapshot, plans)
