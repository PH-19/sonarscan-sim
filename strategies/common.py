import math


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def distance(a: dict, b: dict) -> float:
    return math.hypot(b["x"] - a["x"], b["y"] - a["y"])


def angle_to_target(origin: dict, target: dict) -> float:
    angle = math.degrees(math.atan2(target["y"] - origin["y"], target["x"] - origin["x"]))
    return angle % 360.0


def relative_sector_angle(sonar: dict, target: dict) -> float:
    return (angle_to_target(sonar["position"], target) - sonar["mountYaw"]) % 360.0


def full_scan_plan(sonar: dict, max_range: float) -> dict:
    return {
        "sonarId": sonar["id"],
        "minLocalAngle": sonar["minLocalAngle"],
        "maxLocalAngle": sonar["maxLocalAngle"],
        "range": max_range if sonar.get("available", True) else 1.0,
        "assignedTargetIds": [],
        "action": "FULL_SWEEP" if sonar.get("available", True) else "IDLE",
    }


def decision(strategy: str, snapshot: dict, plans: list[dict]) -> dict:
    return {
        "strategy": strategy,
        "generatedAt": snapshot["simulationTime"],
        "plans": plans,
    }
