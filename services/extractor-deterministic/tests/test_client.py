"""The client against a stub API that verifies signatures the way the real HmacGuard does."""
import hashlib
import hmac
import json
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests

from main import process

FIX = pathlib.Path(__file__).resolve().parents[3] / "eval" / "fixtures"
SECRET = "test-secret"


def make_server(posted, secret=SECRET):
    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _authorized(self, signed: bytes) -> bool:
            want = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
            return hmac.compare_digest(self.headers.get("x-signature", ""), want)

        def do_GET(self):
            if not self._authorized(self.path.encode()):
                return self.send_response(401), self.end_headers()
            pdf = (FIX / "pdf" / "clean-01.pdf").read_bytes()
            self.send_response(200)
            self.send_header("content-length", str(len(pdf)))
            self.end_headers()
            self.wfile.write(pdf)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"]))
            if not self._authorized(body):
                return self.send_response(401), self.end_headers()
            posted.append((self.path, json.loads(body)))
            self.send_response(204)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def test_fetches_parses_and_posts_a_signed_result():
    posted = []
    server, url = make_server(posted)
    try:
        result = process(url, SECRET, "clean-01")
    finally:
        server.shutdown()
    assert result["status"] == "verified"
    assert posted == [("/internal/extractions/tier1", result)]


def test_wrong_secret_is_an_error_not_a_silent_skip():
    posted = []
    server, url = make_server(posted)
    try:
        with pytest.raises(requests.HTTPError) as err:
            process(url, "wrong", "clean-01")
    finally:
        server.shutdown()
    assert err.value.response.status_code == 401 and posted == []


def test_document_id_is_url_encoded_before_signing():
    paths = []

    class Echo(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            paths.append(self.path)
            self.send_response(404)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with pytest.raises(requests.HTTPError):
            process(f"http://127.0.0.1:{server.server_port}", SECRET, "a/b c")
    finally:
        server.shutdown()
    assert paths == ["/internal/documents/a%2Fb%20c"]
