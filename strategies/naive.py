from .common import decision, full_scan_plan


def plan(snapshot: dict) -> dict:
    max_range = snapshot["physics"]["maxRange"]
    plans = [full_scan_plan(sonar, max_range) for sonar in snapshot["sonars"]]
    return decision("NAIVE", snapshot, plans)
