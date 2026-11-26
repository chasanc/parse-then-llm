"""Tier 2: render the pages, ask the provider, then distrust the answer. Bytes in, contract payload out."""
import datetime
import re

import pymupdf

FIELDS = ("vendor", "invoiceNumber", "issueDate", "currency", "lineItems", "total")
MAX_PAGES = 5  # shortcut: later pages are ignored, so a long invoice's sum check fails and it lands in needs_review
DPI = 120


def render(pdf: bytes) -> tuple[list[bytes], str]:
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    if doc.page_count == 0:
        raise ValueError("no pages")
    pages = list(doc)[:MAX_PAGES]
    return [p.get_pixmap(dpi=DPI).tobytes("png") for p in pages], "\n".join(p.get_text() for p in pages).strip()


def clean(raw: dict) -> dict:
    """Keep only values that satisfy the contract. A bad field becomes absent, never a repaired guess."""
    def text(v):
        return v.strip() if isinstance(v, str) and v.strip() else None

    def minor(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None

    date = text(raw.get("issueDate"))
    try:
        date = datetime.date.fromisoformat(date).isoformat() if date else None
    except ValueError:
        date = None
    currency = text(raw.get("currency"))
    currency = currency.upper() if currency and re.fullmatch(r"[A-Za-z]{3}", currency) else None

    items = []
    for i in raw.get("lineItems") or []:
        d, q, u, a = (i.get(k) if isinstance(i, dict) else None for k in ("description", "quantity", "unitPrice", "amount"))
        if text(d) and isinstance(q, int) and not isinstance(q, bool) and q >= 1 and minor(u) is not None and minor(a) is not None:
            items.append(dict(description=text(d), quantity=q, unitPrice=u, amount=a))
        else:
            items = []  # one unreadable row poisons the list: partial items would pass for complete ones
            break
    return dict(vendor=text(raw.get("vendor")), invoiceNumber=text(raw.get("invoiceNumber")), issueDate=date,
                currency=currency, lineItems=items, total=minor(raw.get("total")))


def extract(pdf: bytes, document_id: str, provider) -> dict:
    try:
        images, text = render(pdf)
    except Exception:
        fields = dict(vendor=None, invoiceNumber=None, issueDate=None, currency=None, lineItems=[], total=None)
        return payload(document_id, "failed", fields)  # unreadable file: there is nothing to show a model
    raw = provider(document_id, images, text)  # a provider error propagates: no result beats a fake one
    usage = raw.pop("usage", None)  # token counts, when the provider reports them (the mock does not)
    fields = clean(raw)
    holds = bool(fields["lineItems"]) and all(i["quantity"] * i["unitPrice"] == i["amount"] for i in fields["lineItems"]) \
        and fields["total"] is not None and sum(i["amount"] for i in fields["lineItems"]) == fields["total"]
    return payload(document_id, "ai_enhanced" if holds else "needs_review", fields, usage)


def payload(document_id: str, status: str, fields: dict, usage: dict | None = None) -> dict:
    present = [f for f in FIELDS if fields[f] not in (None, "", 0, [])]
    out = dict(documentId=document_id, extractionTier=2, coverageScore=round(len(present) / len(FIELDS), 4),
               fieldSources={f: "llm" for f in present}, status=status, **fields)
    return {**out, "usage": usage} if usage else out
