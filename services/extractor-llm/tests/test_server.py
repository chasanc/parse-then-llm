"""The HTTP surface the API's runner calls."""
import hashlib
import hmac
import json
import threading

import pytest
import requests

from main import make_server

SECRET = "test-secret"


def call(url, body: bytes, secret=SECRET):
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return requests.post(url, data=body, headers={"x-signature": sig, "content-type": "application/json"}, timeout=5)


@pytest.fixture
def serve():
    started = []

    def start(run):
        server = make_server(SECRET, run)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        return f"http://127.0.0.1:{server.server_port}/run"

    yield start
    for s in started:
        s.shutdown()


def api_error(code):
    def run(_):
        res = requests.Response()
        res.status_code = code
        raise requests.HTTPError(response=res)
    return run


def test_runs_the_document_and_reports_its_status(serve):
    seen = []
    url = serve(lambda d: seen.append(d) or {"status": "verified"})
    res = call(url, json.dumps({"documentId": "clean-01"}).encode())
    assert (res.status_code, res.json()) == (200, {"status": "verified"}) and seen == ["clean-01"]


def test_rejects_a_bad_signature_without_running(serve):
    url = serve(lambda d: pytest.fail("must not run"))
    assert call(url, b'{"documentId":"x"}', secret="other").status_code == 401


@pytest.mark.parametrize("body", [b"not json", b"{}", b'{"documentId":"../etc"}', b'{"documentId":5}'])
def test_rejects_a_malformed_request(serve, body):
    url = serve(lambda d: pytest.fail("must not run"))
    assert call(url, body).status_code == 400


def test_missing_document_is_terminal_404_and_other_api_errors_are_retryable_502(serve):
    assert call(serve(api_error(404)), b'{"documentId":"x"}').status_code == 404
    assert call(serve(api_error(500)), b'{"documentId":"x"}').status_code == 502


@pytest.mark.parametrize("code,terminal", [(400, True), (401, True), (403, True), (408, False), (409, False), (429, False), (500, False), (529, False)])
def test_model_api_errors_are_terminal_only_when_retrying_cannot_help(serve, code, terminal):
    import anthropic
    from providers import ClaudeProvider

    class Refused(anthropic.APIStatusError):  # skips the SDK's HTTP-response plumbing: only the status matters here
        def __init__(self):
            Exception.__init__(self, "nope")
            self.status_code, self.request_id = code, "req_test"

    class Client:  # the SDK already did its own retries; we only classify what it finally raised
        class messages:
            @staticmethod
            def create(**_):
                raise Refused()

    provider = ClaudeProvider(client=Client)
    url = serve(lambda d: provider(d, [], ""))
    assert call(url, b'{"documentId":"x"}').status_code == (422 if terminal else 502)


def test_unexpected_crash_is_502_and_the_server_keeps_serving(serve):
    calls = []

    def run(d):
        calls.append(d)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return {"status": "verified"}

    url = serve(run)
    assert call(url, b'{"documentId":"x"}').status_code == 502
    assert call(url, b'{"documentId":"x"}').status_code == 200
