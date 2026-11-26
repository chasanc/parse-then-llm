// Merge rule from ADR 0003: empty never overwrites. One precedence chain, no exceptions.

export const SOURCES = ['structured', 'pdf', 'llm'] as const;
export type Source = (typeof SOURCES)[number];

export const FIELDS = ['vendor', 'invoiceNumber', 'issueDate', 'currency', 'lineItems', 'total'] as const;
export type Field = (typeof FIELDS)[number];

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceFields {
  vendor: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  currency: string | null;
  lineItems: LineItem[];
  total: number | null;
}

export type Candidates = Partial<Record<Source, Partial<InvoiceFields>>>;

// shortcut: 0 is absent for every field. Only `total` is a top-level number, so a real
// zero-total invoice lands in needs_review. Revisit if a numeric field where 0 is valid is added.
export function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export type Status = 'verified' | 'ai_enhanced' | 'needs_review' | 'failed';

export function coverage(fields: InvoiceFields): number {
  return FIELDS.filter((f) => isPresent(fields[f])).length / FIELDS.length;
}

// The API derives status from the merged result; the status an extractor posts is not stored.
export function deriveStatus(fields: InvoiceFields, fieldSources: Partial<Record<Field, Source>>): Status {
  const c = coverage(fields);
  if (c === 0) return 'failed';
  const sum = fields.lineItems.reduce((s, li) => s + li.amount, 0);
  if (c < 1 || sum !== fields.total) return 'needs_review';
  return Object.values(fieldSources).includes('llm') ? 'ai_enhanced' : 'verified';
}

export function mergeFields(candidates: Candidates): {
  fields: InvoiceFields;
  fieldSources: Partial<Record<Field, Source>>;
} {
  const fields: Record<string, unknown> = {};
  const fieldSources: Partial<Record<Field, Source>> = {};
  for (const f of FIELDS) {
    const source = SOURCES.find((s) => isPresent(candidates[s]?.[f]));
    fields[f] = source ? candidates[source]![f] : f === 'lineItems' ? [] : null;
    if (source) fieldSources[f] = source;
  }
  return { fields: fields as unknown as InvoiceFields, fieldSources };
}
