from .baselines import (
    plan_max_aoi_greedy,
    plan_nearest_roi,
    plan_round_robin_roi,
    plan_round_robin_sector,
    plan_uncertainty_greedy,
)
from .naive import plan as plan_naive
from .pso import plan as plan_pso
from .proposed_v2 import (
    plan as plan_belief_pso_v2,
    plan_fixed_range,
    plan_no_coverage,
    plan_no_pso,
    plan_no_uncertainty,
)
from .proposed_v3 import (
    plan as plan_belief_pso_v3,
    plan_no_constrained_repair as plan_v3_no_constrained_repair,
    plan_fixed_range as plan_v3_fixed_range,
    plan_no_coverage as plan_v3_no_coverage,
    plan_no_pso as plan_v3_no_pso,
    plan_no_redundant_tracking as plan_v3_no_redundant_tracking,
    plan_no_reserve_search as plan_v3_no_reserve_search,
    plan_no_uncertainty as plan_v3_no_uncertainty,
)

STRATEGIES = {
    "NAIVE": plan_naive,
    "FULL_SCAN": plan_naive,
    "FULL_SWEEP": plan_naive,
    "NEAREST_ROI": plan_nearest_roi,
    "MAX_AOI_GREEDY": plan_max_aoi_greedy,
    "UNCERTAINTY_GREEDY": plan_uncertainty_greedy,
    "ROUND_ROBIN_SECTOR": plan_round_robin_sector,
    "ROUND_ROBIN_ROI": plan_round_robin_roi,
    "PSO_V1": plan_pso,
    "BELIEF_PSO_V2": plan_belief_pso_v2,
    "BELIEF_PSO_NO_COVERAGE": plan_no_coverage,
    "BELIEF_PSO_NO_UNCERTAINTY": plan_no_uncertainty,
    "BELIEF_PSO_FIXED_RANGE": plan_fixed_range,
    "BELIEF_PSO_NO_PSO": plan_no_pso,
    "BELIEF_PSO_V3": plan_belief_pso_v3,
    "BELIEF_PSO_V3_NO_COVERAGE": plan_v3_no_coverage,
    "BELIEF_PSO_V3_NO_UNCERTAINTY": plan_v3_no_uncertainty,
    "BELIEF_PSO_V3_FIXED_RANGE": plan_v3_fixed_range,
    "BELIEF_PSO_V3_NO_PSO": plan_v3_no_pso,
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": plan_v3_no_constrained_repair,
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": plan_v3_no_redundant_tracking,
    "BELIEF_PSO_V3_NO_RESERVE_SEARCH": plan_v3_no_reserve_search,
}


def run_strategy(name: str, snapshot: dict) -> dict:
    normalized = name.upper()
    try:
        planner = STRATEGIES[normalized]
    except KeyError as exc:
        available = ", ".join(sorted(STRATEGIES))
        raise ValueError(f"Unknown strategy {name!r}. Available: {available}") from exc
    result = planner(snapshot)
    result["strategy"] = normalized
    return result
