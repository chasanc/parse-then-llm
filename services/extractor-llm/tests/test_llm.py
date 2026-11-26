import json
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest

from llm import clean, extract
from main import process, sign
from providers import ClaudeProvider, MockProvider, SCHEMA

FIX = pathlib.Path(__file__).resolve().parents[3] / "eval" / "fixtures"
FIELDS = ("vendor", "invoiceNumber", "issueDate", "currency", "lineItems", "total")
TIER_2 = {"shifted-03": "ai_enhanced", "scanned-01": "ai_enhanced", "scanned-02": "ai_enhanced",
          "mismatch-01": "needs_review", "mismatch-02": "needs_review", "empty-01": "needs_review"}


def pdf(name):
    return (FIX / "pdf" / f"{name}.pdf").read_bytes()


@pytest.mark.parametrize("name,status", TIER_2.items())
def test_mock_provider_replays_the_answer_key_with_the_right_status(name, status):
    got = extract(pdf(name), name, MockProvider())
    want = json.loads((FIX / "expected" / f"{name}.json").read_text())
    assert got["extractionTier"] == 2 and got["status"] == status
    assert {f: got[f] for f in FIELDS} == {f: want[f] for f in FIELDS}
    assert set(got["fieldSources"].values()) <= {"llm"}


def test_corrupt_pdf_fails_without_calling_the_model():
    def boom(*a):
        raise AssertionError("provider must not be called")
    assert extract(pdf("corrupt-01"), "corrupt-01", boom)["status"] == "failed"


def test_provider_error_propagates_so_nothing_is_posted():
    def down(*a):
        raise RuntimeError("503")
    with pytest.raises(RuntimeError):
        extract(pdf("clean-01"), "clean-01", down)


def test_clean_drops_bad_values_instead_of_repairing_them():
    got = clean(dict(vendor="  ", invoiceNumber=" A-1 ", issueDate="2026-02-30", currency="usd",
                     lineItems=[dict(description="x", quantity=1, unitPrice=100, amount=100)], total=12.5))
    assert got == dict(vendor=None, invoiceNumber="A-1", issueDate=None, currency="USD",
                       lineItems=[dict(description="x", quantity=1, unitPrice=100, amount=100)], total=None)


def test_one_bad_row_discards_all_items():
    rows = [dict(description="a", quantity=1, unitPrice=1, amount=1), dict(description="b", quantity=0, unitPrice=1, amount=0)]
    assert clean(dict(lineItems=rows))["lineItems"] == []


def test_a_wrong_product_is_not_ai_enhanced():
    bad = dict(vendor="V", invoiceNumber="1", issueDate="2026-01-01", currency="USD", total=100,
               lineItems=[dict(description="x", quantity=2, unitPrice=50, amount=90)])
    assert extract(pdf("clean-01"), "d", lambda *a: bad)["status"] == "needs_review"


def test_claude_provider_sends_images_and_schema_and_parses_the_reply():
    seen = {}

    def create(**kw):
        seen.update(kw)
        answer = json.loads((FIX / "expected" / "scanned-01.json").read_text())
        return SimpleNamespace(stop_reason="end_turn", _request_id="req_1",
                               usage=SimpleNamespace(input_tokens=1200, output_tokens=80),
                               content=[SimpleNamespace(type="text", text=json.dumps({f: answer[f] for f in FIELDS}))])

    provider = ClaudeProvider(model="m", client=SimpleNamespace(messages=SimpleNamespace(create=create)))
    got = extract(pdf("scanned-01"), "scanned-01", provider)
    assert got["status"] == "ai_enhanced" and got["total"] == 15000
    assert got["usage"] == {"inputTokens": 1200, "outputTokens": 80}
    assert "usage" not in extract(pdf("scanned-01"), "scanned-01", MockProvider())
    assert seen["model"] == "m" and seen["output_config"]["format"]["schema"] == SCHEMA
    assert seen["messages"][0]["content"][0]["type"] == "image"


def test_claude_refusal_raises():
    reply = SimpleNamespace(stop_reason="refusal", _request_id="req_2", content=[])
    provider = ClaudeProvider(model="m", client=SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: reply)))
    with pytest.raises(RuntimeError, match="refusal"):
        extract(pdf("scanned-01"), "scanned-01", provider)


def test_posts_a_signed_tier2_result():
    posted = []

    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            assert self.headers["x-signature"] == sign("s", self.path.encode())
            data = pdf("scanned-01")
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"]))
            assert self.headers["x-signature"] == sign("s", body)
            posted.append((self.path, json.loads(body)))
            self.send_response(204)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        result = process(f"http://127.0.0.1:{server.server_port}", "s", "scanned-01", MockProvider())
    finally:
        server.shutdown()
    assert posted == [("/internal/extractions/tier2", result)] and result["status"] == "ai_enhanced"
