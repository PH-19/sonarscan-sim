import json
import sys

from . import run_strategy


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = {
                "requestId": request["requestId"],
                "decision": run_strategy(request["strategy"], request["snapshot"]),
            }
        except Exception as exc:
            response = {
                "requestId": request.get("requestId") if isinstance(request, dict) else None,
                "error": str(exc),
            }
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
