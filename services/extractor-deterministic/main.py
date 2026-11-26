"""Tier 1 worker: fetch a document from the API, parse it, post the result. One document per call.

    API_URL=http://localhost:3000 HMAC_SECRET=... uv run main.py <documentId>
    ... uv run main.py serve        # long-running: the API's runner calls POST /run on $PORT (default 8000)
"""
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

from parse import extract


def sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def process(api_url: str, secret: str, document_id: str, threshold: float = 1.0) -> dict:
    # The API signs a body-less GET over its URL path.
    path = f"/internal/documents/{urllib.parse.quote(document_id, safe='')}"
    res = requests.get(api_url + path, headers={"x-signature": sign(secret, path.encode())}, timeout=30)
    res.raise_for_status()
    read = {"x-document-sha256": res.headers["x-document-sha256"]} if "x-document-sha256" in res.headers else {}

    payload = extract(res.content, document_id, threshold)
    body = json.dumps(payload).encode()
    # The echoed hash lets the API drop this result if the document was replaced while we were working.
    res = requests.post(api_url + "/internal/extractions/tier1", data=body, timeout=30,
                        headers={"content-type": "application/json", "x-signature": sign(secret, body), **read})
    res.raise_for_status()  # a rejected result must never be reported as done
    return payload


ID = re.compile(r"[A-Za-z0-9._-]{1,128}")


def make_server(secret: str, run, port: int = 0) -> ThreadingHTTPServer:
    """POST /run {"documentId"} signed like every internal call. 200 done, 404 no such document
    (terminal), 502 anything else (the runner retries). Copy of the Tier 2 server: they deploy separately."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            if not hmac.compare_digest(self.headers.get("x-signature", ""), sign(secret, body)):
                return self.reply(401, {"error": "bad signature"})
            try:
                document_id = json.loads(body)["documentId"]
                if not isinstance(document_id, str) or not ID.fullmatch(document_id):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {"error": "documentId required"})
            try:
                result = run(document_id)
            except requests.HTTPError as e:
                logging.error("API answered %s for %s", e.response.status_code, document_id)
                code = e.response.status_code
                # 404 and other 4xx (except 408/429) are terminal for this job; the runner must not retry them.
                terminal = 400 <= code < 500 and code not in (408, 429)
                return self.reply(code if terminal else 502, {"error": "api error"})
            except Exception:
                logging.exception("extract failed for %s", document_id)
                return self.reply(502, {"error": "extract failed"})
            self.reply(200, {"status": result["status"]})

    return ThreadingHTTPServer(("0.0.0.0", port), Handler)


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        api_url, secret = os.environ["API_URL"], os.environ["HMAC_SECRET"]
        threshold = float(os.environ.get("COVERAGE_THRESHOLD", "1.0"))
        make_server(secret, lambda d: process(api_url, secret, d, threshold), int(os.environ.get("PORT", "8000"))).serve_forever()
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        result = process(os.environ["API_URL"], os.environ["HMAC_SECRET"], sys.argv[1],
                         float(os.environ.get("COVERAGE_THRESHOLD", "1.0")))
    except KeyError as e:
        sys.exit(f"{e.args[0]} is required")
    except requests.HTTPError as e:
        sys.exit(f"API answered {e.response.status_code} for {e.response.url}")
    print(f"{result['documentId']}: {result['status']} coverage={result['coverageScore']}")
