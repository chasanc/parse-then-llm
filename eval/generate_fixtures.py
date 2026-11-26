#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Generate synthetic invoice PDFs plus the expected canonical JSON. Fully deterministic."""
import datetime
import json
import pathlib

import pymupdf as fitz

OUT = pathlib.Path(__file__).parent / "fixtures"
SYMBOL = {"USD": "$", "EUR": "EUR ", "GBP": "GBP "}  # base-14 fonts lack reliable € / £ glyphs


def inv(layout, vendor, number, date, cur, items, outcome="tier1", printed_total=None):
    total = sum(q * u for _, q, u in items)
    return dict(layout=layout, vendor=vendor, invoiceNumber=number, issueDate=date, currency=cur,
                items=items, outcome=outcome, total=total, printed_total=printed_total or total)


# outcome: tier1 (resolved by parser), tier2 (needs LLM), review (invariant fails), failed
INVOICES = {
    "clean-01": inv("standard", "Northwind Supplies Ltd", "INV-2026-0001", "2026-01-15", "USD",
                    [("Widget A", 10, 1250), ("Widget B", 4, 3099), ("Shipping", 1, 1500)]),
    "clean-02": inv("standard", "Bluebird Logistics GmbH", "BB-77213", "2026-02-03", "EUR",
                    [("Pallet transport", 2, 45000), ("Fuel surcharge", 2, 3250), ("Insurance", 1, 8900),
                     ("Customs fee", 1, 2500), ("Handling", 3, 1200)]),
    "clean-03": inv("standard", "Ridgeway Consulting", "RC-0042", "2026-03-09", "GBP",
                    [("Advisory day", 5, 80000)]),
    "shifted-01": inv("columns", "Harbor & Pine Co", "HP-5510", "2026-04-21", "USD",
                      [("Oak plank", 12, 2400), ("Pine beam", 3, 9800), ("Delivery", 1, 4500)]),
    "shifted-02": inv("symbols", "Lumen Stationers", "LS/2026/118", "2026-05-02", "GBP",
                      [("Notebooks", 20, 350), ("Ink set", 6, 1299)]),
    "shifted-03": inv("prose", "Quarry Lane Bakery", "QLB-9", "2026-06-14", "EUR",
                      [("Sourdough loaf", 40, 450), ("Croissant box", 8, 1800)], outcome="tier2"),
    "scanned-01": inv("standard", "Meridian Print Works", "MP-3301", "2026-07-07", "USD",
                      [("Business cards", 500, 12), ("Flyers", 200, 45)], outcome="tier2"),
    "scanned-02": inv("columns", "Olivetti Cafe Supplies", "OC-2208", "2026-08-19", "EUR",
                      [("Espresso beans 1kg", 6, 2150), ("Filters", 10, 390)], outcome="tier2"),
    "mismatch-01": inv("standard", "Delta Freight Inc", "DF-1001", "2026-09-01", "USD",
                       [("Freight", 1, 50000), ("Fee", 1, 2500)], outcome="review", printed_total=55000),
    "mismatch-02": inv("symbols", "Evergreen Tools", "EG-640", "2026-10-12", "GBP",
                       [("Drill", 2, 8900), ("Bits", 4, 1250)], outcome="review", printed_total=21000),
    "empty-01": dict(outcome="failed", tier=2),
    "corrupt-01": dict(outcome="failed", tier=1),
}


def money(minor, cur="", sym=False):
    s = f"{minor // 100:,}.{minor % 100:02d}"
    return SYMBOL[cur] + s if sym else s


def draw(page, i):
    def t(x, y, s, size=10):
        page.insert_text((x, y), s, fontname="helv", fontsize=size)

    layout, cur = i["layout"], i["currency"]
    if layout == "standard":
        t(50, 60, i["vendor"], 16)
        t(50, 90, f"Invoice #: {i['invoiceNumber']}")
        t(50, 105, f"Date: {i['issueDate']}")
        t(50, 120, f"Currency: {cur}")
        y = 160
        for x, h in ((50, "Description"), (300, "Qty"), (360, "Unit Price"), (460, "Amount")):
            t(x, y, h)
        for d, q, u in i["items"]:
            y += 16
            t(50, y, d); t(300, y, str(q)); t(360, y, money(u)); t(460, y, money(q * u))
        t(400, y + 30, f"Total: {money(i['printed_total'])}")
    elif layout == "columns":  # right-hand header block, reordered columns, different total label
        t(50, 60, i["vendor"], 16)
        t(350, 90, f"Invoice No. {i['invoiceNumber']}")
        t(350, 105, f"Issue date {i['issueDate']}")
        t(350, 120, f"All amounts in {cur}")
        y = 160
        for x, h in ((50, "Qty"), (100, "Amount"), (180, "Unit"), (260, "Item")):
            t(x, y, h)
        for d, q, u in i["items"]:
            y += 16
            t(50, y, str(q)); t(100, y, money(q * u)); t(180, y, money(u)); t(260, y, d)
        t(50, y + 30, f"Amount Due {money(i['printed_total'])}")
    elif layout == "symbols":  # no currency code, "Ref", long date, symbol-prefixed amounts
        d = datetime.date.fromisoformat(i["issueDate"])
        t(50, 60, i["vendor"], 16)
        t(50, 90, f"Ref: {i['invoiceNumber']}")
        t(50, 105, f"Issued {d.day} {d.strftime('%b %Y')}")
        y = 150
        for desc, q, u in i["items"]:
            t(50, y, f"{desc}  x{q}  @ {money(u, cur, True)}  = {money(q * u, cur, True)}")
            y += 16
        t(50, y + 20, f"TOTAL {money(i['printed_total'], cur, True)}", 12)
    else:  # prose: no labels, no table
        lines = ", ".join(f"{q} x {d} at {money(u)}" for d, q, u in i["items"])
        text = (f"{i['vendor']} writes regarding invoice {i['invoiceNumber']} dated {i['issueDate']}. "
                f"It covers {lines}. Please remit {money(i['printed_total'])} {cur} at your convenience.")
        page.insert_textbox(fitz.Rect(50, 60, 545, 400), text, fontname="helv", fontsize=11)


def save(doc, name):
    doc.set_metadata({"producer": "", "creator": "", "creationDate": "", "modDate": ""})
    doc.save(OUT / "pdf" / f"{name}.pdf", deflate=True, no_new_id=True)


def expected(name, i):
    base = dict(documentId=name)
    if i["outcome"] == "failed":
        return dict(base, extractionTier=i["tier"], coverageScore=0, fieldSources={}, status="failed",
                    vendor=None, invoiceNumber=None, issueDate=None, currency=None, lineItems=[], total=None)
    source = "llm" if i["outcome"] == "tier2" else "pdf"
    tier = 1 if i["outcome"] == "tier1" else 2
    status = {"tier1": "verified", "tier2": "ai_enhanced", "review": "needs_review"}[i["outcome"]]
    fields = dict(vendor=i["vendor"], invoiceNumber=i["invoiceNumber"], issueDate=i["issueDate"],
                  currency=i["currency"],
                  lineItems=[dict(description=d, quantity=q, unitPrice=u, amount=q * u) for d, q, u in i["items"]],
                  total=i["printed_total"])
    return dict(base, extractionTier=tier, coverageScore=1, fieldSources={k: source for k in fields},
                status=status, **fields)


def main():
    for sub in ("pdf", "expected"):
        (OUT / sub).mkdir(parents=True, exist_ok=True)
    for name, i in INVOICES.items():
        if name.startswith("corrupt"):
            (OUT / "pdf" / f"{name}.pdf").write_bytes(b"%PDF-1.7\n1 0 obj\n<< /Type /Cat")  # truncated
        elif name.startswith("empty"):
            doc = fitz.open(); doc.new_page(); save(doc, name)
        else:
            doc = fitz.open(); page = doc.new_page(); draw(page, i)
            if name.startswith("scanned"):  # rasterize: no text layer survives
                pix = page.get_pixmap(dpi=150)
                doc = fitz.open(); doc.new_page().insert_image(page.rect, pixmap=pix)
            save(doc, name)
        (OUT / "expected" / f"{name}.json").write_text(
            json.dumps(expected(name, i), indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(INVOICES)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
