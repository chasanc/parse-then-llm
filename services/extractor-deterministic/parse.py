"""Tier 1: parse an invoice PDF from its text layer. Pure: bytes in, contract payload out."""
import datetime
import re
from statistics import median

import pymupdf

FIELDS = ("vendor", "invoiceNumber", "issueDate", "currency", "lineItems", "total")
TOTAL_ROW = re.compile(r"^(?:Total|TOTAL|Amount Due)\b:?\s*(.+)$")
INLINE_ITEM = re.compile(r"^(?P<desc>.+?)\s+x(?P<qty>\d+)\s+@\s+(?P<unit>[^=]+?)\s*=\s*(?P<amount>.+)$")
CODE = re.compile(r"\b(USD|EUR|GBP)\b")
CURRENCY_SYMBOL = {"$": "USD"}
HEADER_KIND = {"description": "desc", "item": "desc", "qty": "qty", "quantity": "qty",
               "unit": "unit", "unit price": "unit", "amount": "amount"}


def money(text: str) -> int | None:
    """'EUR 1,250.00' / '$12.50' -> integer minor units. Needs exactly two decimals.

    A negative amount ('-$5.00', '($5.00)') is None: the contract has no negative money, and reading a credit as a
    charge would pass the sum check with the wrong sign."""
    m = re.search(r"(\d[\d,]*)\.(\d{2})\b", text)
    if not m or re.search(r"-\s*[^\d\s]{0,3}\s*$|\(\s*[^\d\s]{0,3}\s*$", text[:m.start()]):
        return None
    return int(m.group(1).replace(",", "")) * 100 + int(m.group(2))


def parse_date(text: str) -> str | None:
    if m := re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text):
        try:
            return datetime.date.fromisoformat(m.group(1)).isoformat()
        except ValueError:
            return None
    if m := re.search(r"\b(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})\b", text):
        try:
            return datetime.datetime.strptime(" ".join(m.groups()), "%d %b %Y").date().isoformat()
        except ValueError:
            return None
    return None


def read_rows(page):
    """Spans grouped into visual rows (top to bottom), each row left to right: (text, x0, size)."""
    spans = []
    # Without this flag "dict" decodes every page image into bytes: ~50 ms per scanned page, and in a 20 MB scan
    # memory that was never given back (about 40 MB lost per call). Text rows never need the pixels.
    flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    for block in page.get_text("dict", flags=flags)["blocks"]:
        for line in block.get("lines", []):
            for s in line["spans"]:
                if s["text"].strip():
                    spans.append((round(s["origin"][1]), s["text"].strip(), s["bbox"][0], s["size"]))
    rows: list[list] = []
    for y, text, x0, size in sorted(spans, key=lambda s: (s[0], s[2])):
        if rows and abs(rows[-1][0] - y) <= 2:
            rows[-1][1].append((text, x0, size))
        else:
            rows.append([y, [(text, x0, size)]])
    return [sorted(cells, key=lambda c: c[1]) for _, cells in rows]


def items_from_table(rows):
    """Find the header row, map each cell below it to the nearest column on its left."""
    for n, row in enumerate(rows):
        kinds = [(HEADER_KIND.get(t.lower()), x0) for t, x0, _ in row]
        if {"qty", "amount"} <= {k for k, _ in kinds if k} and len(kinds) >= 3:
            cols = [(k, x0) for k, x0 in kinds if k]
            break
    else:
        return None
    items = []
    for row in rows[n + 1:]:
        if TOTAL_ROW.match(" ".join(t for t, _, _ in row)):
            break
        cells = {}
        for text, x0, _ in row:
            kind = [k for k, cx in cols if cx <= x0 + 2][-1:] or [cols[0][0]]
            cells[kind[0]] = text
        qty, unit, amount = cells.get("qty", ""), money(cells.get("unit", "")), money(cells.get("amount", ""))
        if not (qty.isdigit() and cells.get("desc") and unit is not None and amount is not None):
            return None  # a row we cannot read: better to escalate than to drop it silently
        items.append(dict(description=cells["desc"], quantity=int(qty), unitPrice=unit, amount=amount))
    return items


def items_inline(rows):
    items = []
    for row in rows:
        m = INLINE_ITEM.match(" ".join(t for t, _, _ in row))
        if m and (unit := money(m["unit"])) is not None and (amount := money(m["amount"])) is not None:
            items.append(dict(description=m["desc"], quantity=int(m["qty"]), unitPrice=unit, amount=amount))
    return items


def extract(pdf: bytes, document_id: str, threshold: float = 1.0) -> dict:
    empty = dict(vendor=None, invoiceNumber=None, issueDate=None, currency=None, lineItems=[], total=None)

    def payload(status, fields, **kw):
        present = [f for f in FIELDS if fields[f] not in (None, "", 0, [])]
        return dict(documentId=document_id, extractionTier=1, coverageScore=round(len(present) / len(FIELDS), 4),
                    fieldSources={f: "pdf" for f in present}, status=status, **fields)

    try:
        doc = pymupdf.open(stream=pdf, filetype="pdf")
        if doc.page_count == 0:
            raise ValueError("no pages")
        page = doc[0]  # shortcut: first page only; items on later pages make the sum check fail and escalate
        rows = read_rows(page)
    except Exception:
        return payload("failed", empty)  # unreadable file: Tier 2 cannot help either
    if not rows:
        return payload("needs_review", empty)  # scanned or blank page: nothing a text parser can do

    lines = [" ".join(t for t, _, _ in row) for row in rows]
    body = median(size for row in rows for _, _, size in row)
    biggest = max(size for row in rows for _, _, size in row)
    fields = dict(empty)
    if biggest > body:  # the vendor is the heading; with no heading we would be guessing
        fields["vendor"] = next(t for row in rows for t, _, size in row if size == biggest)

    for line in lines:
        if not fields["invoiceNumber"] and (m := re.match(r"^(?:Invoice\s*(?:#|No\.?|Number)|Ref)\s*:?\s*(\S+)$", line)):
            fields["invoiceNumber"] = m.group(1)
        if not fields["issueDate"] and re.match(r"^(?:Date:|Issue date|Issued)\s", line):
            fields["issueDate"] = parse_date(line)
        if not fields["currency"] and (m := re.match(r"^(?:Currency:|All amounts in)\s*([A-Z]{3})$", line)):
            fields["currency"] = m.group(1)

    total_line = next((m for line in lines if (m := TOTAL_ROW.match(line))), None)
    if total_line:
        fields["total"] = money(total_line.group(1))
        if not fields["currency"]:
            code = CODE.search(total_line.group(1))
            symbol = next((c for s, c in CURRENCY_SYMBOL.items() if s in total_line.group(1)), None)
            fields["currency"] = code.group(1) if code else symbol

    fields["lineItems"] = items_from_table(rows) or items_inline(rows)

    invariants_hold = all(i["quantity"] * i["unitPrice"] == i["amount"] for i in fields["lineItems"]) and (
        fields["total"] is not None and sum(i["amount"] for i in fields["lineItems"]) == fields["total"])
    result = payload("verified", fields)
    if result["coverageScore"] < threshold or not invariants_hold:
        result["status"] = "needs_review"
    return result
