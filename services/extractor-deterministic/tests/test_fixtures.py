import json
import pathlib

import pytest

from parse import extract, money, parse_date

FIX = pathlib.Path(__file__).resolve().parents[3] / "eval" / "fixtures"
NAMES = sorted(p.stem for p in (FIX / "expected").glob("*.json"))
FIELDS = ("vendor", "invoiceNumber", "issueDate", "currency", "lineItems", "total")

# What Tier 1 must do per fixture. Everything else is Tier 2's job.
PARSED = ["clean-01", "clean-02", "clean-03", "shifted-01", "shifted-02"]
INVARIANT_FAILS = ["mismatch-01", "mismatch-02"]  # parsed fully, but the sums disagree
UNREADABLE_TEXT = ["shifted-03", "scanned-01", "scanned-02", "empty-01"]


def run(name):
    return extract((FIX / "pdf" / f"{name}.pdf").read_bytes(), name)


def expected(name):
    return json.loads((FIX / "expected" / f"{name}.json").read_text())


def test_every_fixture_is_classified():
    assert set(NAMES) == set(PARSED + INVARIANT_FAILS + UNREADABLE_TEXT + ["corrupt-01"])


@pytest.mark.parametrize("name", PARSED)
def test_clean_layouts_are_verified_exactly(name):
    got, want = run(name), expected(name)
    assert got["status"] == "verified" and got["coverageScore"] == 1
    assert {f: got[f] for f in FIELDS} == {f: want[f] for f in FIELDS}
    assert set(got["fieldSources"].values()) == {"pdf"}


@pytest.mark.parametrize("name", INVARIANT_FAILS)
def test_invariant_failure_escalates_with_fields_intact(name):
    got, want = run(name), expected(name)
    assert got["status"] == "needs_review"
    assert {f: got[f] for f in FIELDS} == {f: want[f] for f in FIELDS}
    assert sum(i["amount"] for i in got["lineItems"]) != got["total"]


@pytest.mark.parametrize("name", UNREADABLE_TEXT)
def test_unreadable_pages_escalate_without_guessing(name):
    got = run(name)
    assert got["status"] == "needs_review"
    assert got["coverageScore"] < 1
    # whatever it did find must be right, and it must never invent a line item
    want = expected(name)
    for f in FIELDS:
        assert got[f] in (None, [], want[f])
    assert got["lineItems"] == [] or got["lineItems"] == want["lineItems"]


def test_prose_layout_finds_nothing():
    assert run("shifted-03")["coverageScore"] == 0


def test_corrupt_file_fails_at_tier_1():
    got = run("corrupt-01")
    assert got["status"] == "failed" and got["coverageScore"] == 0 and got["lineItems"] == []


def test_not_a_pdf_at_all_fails():
    assert extract(b"hello", "x")["status"] == "failed"


@pytest.mark.parametrize("text,cents", [("1,250.00", 125000), ("$12.50", 1250), ("GBP 0.05", 5), ("12", None), ("1.5", None)])
def test_money(text, cents):
    assert money(text) == cents


@pytest.mark.parametrize("text,iso", [("Date: 2026-01-15", "2026-01-15"), ("Issued 2 May 2026", "2026-05-02"),
                                      ("Date: 2026-13-45", None), ("Issued 31 Foo 2026", None), ("nothing", None)])
def test_dates(text, iso):
    assert parse_date(text) == iso
