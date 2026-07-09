import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import run_strategy


class StrategyHandler(BaseHTTPRequestHandler):
    def _headers(self, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self._headers(204)

    def do_POST(self) -> None:
        if self.path != "/plan":
            self._headers(404)
            self.wfile.write(b'{"error":"not found"}')
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            result = run_strategy(payload["strategy"], payload["snapshot"])
            body = json.dumps(result, separators=(",", ":")).encode()
            self._headers(200)
            self.wfile.write(body)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self._headers(400)
            self.wfile.write(json.dumps({"error": str(exc)}).encode())
        except Exception as exc:  # keep the simulation alive and surface server failures
            self._headers(500)
            self.wfile.write(json.dumps({"error": str(exc)}).encode())

    def log_message(self, format: str, *args) -> None:
        print(f"[strategy] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sonar simulation Python strategy service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), StrategyHandler)
    print(f"Strategy service listening on http://{args.host}:{args.port}/plan")
    server.serve_forever()


if __name__ == "__main__":
    main()
