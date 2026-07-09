import math

from .common import clamp, decision, distance, full_scan_plan, relative_sector_angle

PADDING_ANGLE = 25.0
PADDING_RANGE = 5.0
MIN_SWEEP_DEG = 20.0
SEARCH_SWEEP_DEG = 30.0


def _eligible_tracks(snapshot: dict) -> list[dict]:
    """Return non-lost tracks with reasonable confidence."""
    result = []
    for track in snapshot.get("tracks", []):
        if track.get("status") == "lost":
            continue
        confidence = track.get("confidence", 0.0)
        if confidence >= 0.3:
            result.append(track)
    return result


def _sonar_can_see(sonar: dict, track: dict) -> bool:
    return relative_sector_angle(sonar, track.get("position", track)) <= sonar["maxLocalAngle"]


def _roi_plan(sonar: dict, tracks: list[dict], max_range: float) -> dict:
    if not tracks:
        return full_scan_plan(sonar, max_range)

    angles = [
        relative_sector_angle(sonar, t.get("position", t))
        for t in tracks
        if _sonar_can_see(sonar, t)
    ]
    if not angles:
        return full_scan_plan(sonar, max_range)

    min_rel = clamp(min(angles) - PADDING_ANGLE, sonar["minLocalAngle"], sonar["maxLocalAngle"])
    max_rel = clamp(max(angles) + PADDING_ANGLE, sonar["minLocalAngle"], sonar["maxLocalAngle"])
    if max_rel - min_rel < MIN_SWEEP_DEG:
        center = (min_rel + max_rel) / 2.0
        min_rel = clamp(center - MIN_SWEEP_DEG / 2, sonar["minLocalAngle"], sonar["maxLocalAngle"])
        max_rel = clamp(center + MIN_SWEEP_DEG / 2, sonar["minLocalAngle"], sonar["maxLocalAngle"])

    rng = min(
        max_range,
        max(distance(sonar["position"], t.get("position", t)) for t in tracks) + PADDING_RANGE,
    )

    return {
        "sonarId": sonar["id"],
        "minLocalAngle": min_rel,
        "maxLocalAngle": max_rel,
        "range": clamp(rng, 1.0, max_range),
        "assignedTargetIds": [t["id"] for t in tracks],
        "action": "TRACK_ROI",
    }


def _search_plan(sonar: dict, sonar_index: int, snapshot: dict) -> dict:
    bucket = int(snapshot["simulationTime"] / 2.5)
    shift = (bucket + sonar_index * 3) % 6
    centers = [30, 90, 150]
    center = centers[shift % 3]
    min_angle = clamp(center - SEARCH_SWEEP_DEG / 2, sonar["minLocalAngle"], sonar["maxLocalAngle"] - SEARCH_SWEEP_DEG)
    return {
        "sonarId": sonar["id"],
        "minLocalAngle": min_angle,
        "maxLocalAngle": min_angle + SEARCH_SWEEP_DEG,
        "range": snapshot["physics"]["maxRange"],
        "assignedTargetIds": [],
        "action": "SEARCH_SECTOR",
    }


def _assign_tracks(snapshot: dict, prev_assigned: dict | None = None) -> list[list[dict]]:
    """Deterministic load-balanced assignment with hysteresis.

    Sorts tracks by urgency (timeSinceUpdate), assigns each to the nearest
    eligible sonar, balancing load. Prefers keeping tracks on their current
    sonar unless another sonar is significantly better.
    """
    sonars = snapshot["sonars"]
    tracks = _eligible_tracks(snapshot)
    if not tracks:
        return [[] for _ in sonars]

    groups: list[list[dict]] = [[] for _ in sonars]
    sorted_tracks = sorted(tracks, key=lambda t: -(t.get("timeSinceUpdate", 0)))
    prev = prev_assigned or {}

    for track in sorted_tracks:
        track_id = track["id"]
        track_pos = track.get("position", track)
        eligible = [
            i for i, sonar in enumerate(sonars) if _sonar_can_see(sonar, track)
        ]
        if not eligible:
            eligible = [
                min(
                    range(len(sonars)),
                    key=lambda i: distance(sonars[i]["position"], track_pos),
                )
            ]

        prev_sonar = prev.get(track_id)
        if prev_sonar is not None and prev_sonar in eligible:
            best = min(
                eligible,
                key=lambda i: (
                    0 if i == prev_sonar else 1,
                    len(groups[i]),
                    distance(sonars[i]["position"], track_pos),
                ),
            )
        else:
            best = min(
                eligible,
                key=lambda i: (len(groups[i]), distance(sonars[i]["position"], track_pos)),
            )

        groups[best].append(track)

    return groups


def plan(snapshot: dict) -> dict:
    sonars = snapshot["sonars"]
    max_range = snapshot["physics"]["maxRange"]

    prev: dict[str, int] = {}
    for i, sonar in enumerate(sonars):
        for tid in sonar.get("assignedTargetIds", []) or []:
            prev[tid] = i

    groups = _assign_tracks(snapshot, prev)

    plans = []
    for index, sonar in enumerate(sonars):
        if groups[index]:
            plans.append(_roi_plan(sonar, groups[index], max_range))
        else:
            plans.append(_search_plan(sonar, index, snapshot))

    return decision("PSO_V1", snapshot, plans)
