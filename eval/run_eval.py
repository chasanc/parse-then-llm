#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# exclude-newer = "7 days"
# ///
"""Offline eval: push every fixture through a running stack and score it against eval/fixtures/expected.

    docker compose up -d --build
    eval/run_eval.py [--api http://localhost:3000] [--out report.md] [--min-accuracy 1.0]

Uses whatever LLM_PROVIDER the stack runs: `mock` (default, free, deterministic) answers from the expected
files, so with mock the numbers test Tier 1 and the plumbing; set LLM_PROVIDER=claude to test the model.
Exits 1 when field accuracy is below --min-accuracy, any status differs, or any job did not finish (done), so CI can gate on it.
Each run uploads with ?replace=true, which also clears the previous run's result, so every run starts clean.
"""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).parent
FIELDS = ["vendor", "invoiceNumber", "issueDate", "currency", "lineItems", "total"]
# shortcut: flat per-document guess, used only when no prices are given or the provider reports no tokens (the mock).
USD_PER_TIER2_DOC = float(os.environ.get("EST_USD_PER_TIER2_DOC", "0.01"))
ABSENT = {"status": "failed", **{f: None for f in FIELDS}, "lineItems": [], "extractionTier": 0}


def run_one(api: str, pdf: Path, timeout: float) -> tuple[dict, float, str]:
    """Returns (merged result, seconds, job status)."""
    doc_id = pdf.stem
    raw = pdf.read_bytes()
    auth = {"authorization": f"Bearer {os.environ['PTL_API_KEY']}"}
    # replace=true so a re-run against the same stack is allowed to overwrite the previous run's documents.
    requests.put(f"{api}/documents/{doc_id}?replace=true", data=raw, headers={"content-type": "application/pdf", **auth}, timeout=30).raise_for_status()
    start = time.monotonic()
    job = requests.post(f"{api}/jobs", json={"documentId": doc_id, "documentHash": hashlib.sha256(raw).hexdigest(),
                                              "idempotencyKey": f"eval-{doc_id}-{time.time_ns()}"}, headers=auth, timeout=30)
    job.raise_for_status()
    job_id = job.json()["id"]
    while True:
        status = requests.get(f"{api}/jobs/{job_id}", headers=auth, timeout=30).json()["status"]
        if status in ("done", "failed"):
            break
        if time.monotonic() - start > timeout:
            status = "timeout"
            break
        time.sleep(0.25)
    seconds = time.monotonic() - start
    res = requests.get(f"{api}/extractions/{doc_id}", headers=auth, timeout=30)
    return (res.json() if res.status_code == 200 else dict(ABSENT)), seconds, status


def llm_tokens(api: str) -> tuple[float, float]:
    """Cumulative (input, output) model tokens from /metrics; the run's usage is the difference between two reads."""
    text = requests.get(f"{api}/metrics", headers={"authorization": f"Bearer {os.environ['PTL_API_KEY']}"}, timeout=30).text
    got = {d: 0.0 for d in ("input", "output")}
    for line in text.splitlines():
        for d in got:
            if line.startswith(f'llm_tokens_total{{direction="{d}"}} '):
                got[d] = float(line.rsplit(" ", 1)[1])
    return got["input"], got["output"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("API_URL", "http://localhost:3000"))
    ap.add_argument("--out")
    ap.add_argument("--min-accuracy", type=float, default=1.0)
    ap.add_argument("--timeout", type=float, default=120)
    args = ap.parse_args()

    tokens_before = llm_tokens(args.api)
    rows, right, total_fields, tier1, tier2, seconds = [], 0, 0, 0, 0, []
    bad_status = not_done = 0
    for pdf in sorted((HERE / "fixtures/pdf").glob("*.pdf")):
        want = json.loads((HERE / "fixtures/expected" / f"{pdf.stem}.json").read_text())
        got, secs, job = run_one(args.api, pdf, args.timeout)
        wrong = [f for f in FIELDS if got.get(f) != want[f]]
        if job != "done":  # a job that never finished says nothing about extraction quality: flag it, keep it out of accuracy
            not_done += 1
        else:
            right += len(FIELDS) - len(wrong)
            total_fields += len(FIELDS)
        tier1 += got["extractionTier"] == 1 and got["status"] == "verified"
        tier2 += got["extractionTier"] == 2
        seconds.append(secs)
        bad_status += got["status"] != want["status"]
        rows.append(f"| {pdf.stem} | {got['extractionTier']} | {got['status']} | {want['status']} | "
                    f"{len(FIELDS) - len(wrong)}/{len(FIELDS)} | {secs:.2f} | {job}{' ← ' + ', '.join(wrong) if wrong else ''} |")

    n = len(rows)
    used_in, used_out = (a - b for a, b in zip(llm_tokens(args.api), tokens_before))
    price_in, price_out = os.environ.get("LLM_USD_PER_MTOK_IN"), os.environ.get("LLM_USD_PER_MTOK_OUT")
    if price_in and price_out and used_in + used_out:
        cost = f"${(used_in * float(price_in) + used_out * float(price_out)) / 1e6:.4f} (measured tokens x your prices)"
    else:  # mock provider reports no tokens, or no prices given
        cost = f"${tier2 * USD_PER_TIER2_DOC:.2f} (flat ${USD_PER_TIER2_DOC}/Tier-2 doc; set LLM_USD_PER_MTOK_IN/OUT for a measured figure)"
    accuracy = right / total_fields if total_fields else 0.0
    seconds.sort()
    report = "\n".join([
        "# Offline eval", "",
        "| Metric | Value |", "|---|---|",
        f"| Documents | {n} |",
        f"| Resolved at Tier 1 (verified) | {tier1 / n:.0%} |",
        f"| Escalated to Tier 2 | {tier2 / n:.0%} |",
        f"| Jobs not done (failed or timed out) | {not_done}/{n} |",
        f"| Field accuracy (finished jobs only) | {accuracy:.1%} ({right}/{total_fields}) |",
        f"| Status matches expected | {n - bad_status}/{n} |",
        f"| Latency p50 / max | {seconds[n // 2]:.2f}s / {seconds[-1]:.2f}s |",
        f"| LLM tokens (in / out) | {used_in:,.0f} / {used_out:,.0f} |",
        f"| LLM cost | {cost} |",
        "", "| Document | Tier | Status | Expected | Fields | Seconds | Job / wrong fields |", "|---|---|---|---|---|---|---|",
        *rows, "",
    ])
    print(report)
    if args.out:
        Path(args.out).write_text(report)
    return 0 if accuracy >= args.min_accuracy and not bad_status and not not_done else 1


if __name__ == "__main__":
    sys.exit(main())
