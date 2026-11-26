import { describe, expect, it } from 'vitest';
import { deriveStatus, isPresent, mergeFields } from '../src/common/merge';

const item = { description: 'Widget', quantity: 2, unitPrice: 500, amount: 1000 };

describe('isPresent', () => {
  it.each([null, undefined, '', '   ', 0, NaN, []])('%j is absent', (v) => {
    expect(isPresent(v)).toBe(false);
  });
  it.each(['x', 1, -1, [item]])('%j is present', (v) => {
    expect(isPresent(v)).toBe(true);
  });
});

describe('deriveStatus', () => {
  const full = { vendor: 'A', invoiceNumber: '1', issueDate: '2026-01-01', currency: 'USD', lineItems: [item], total: 1000 };
  const all = (s: 'pdf' | 'llm') => ({ vendor: s, invoiceNumber: s, issueDate: s, currency: s, lineItems: s, total: s });

  it('is verified when complete, consistent and no llm field is used', () => {
    expect(deriveStatus(full, all('pdf'))).toBe('verified');
  });
  it('is ai_enhanced when any field came from the llm', () => {
    expect(deriveStatus(full, { ...all('pdf'), vendor: 'llm' })).toBe('ai_enhanced');
  });
  it('is needs_review when line items do not sum to the total', () => {
    expect(deriveStatus({ ...full, total: 1100 }, all('pdf'))).toBe('needs_review');
  });
  it('is needs_review when a field is missing', () => {
    expect(deriveStatus({ ...full, vendor: null }, all('pdf'))).toBe('needs_review');
  });
  it('is failed when nothing was read', () => {
    const none = { vendor: null, invoiceNumber: null, issueDate: null, currency: null, lineItems: [], total: null };
    expect(deriveStatus(none, {})).toBe('failed');
  });
});

describe('mergeFields', () => {
  it('never lets blank, null, zero or empty tier-2 values clobber tier-1', () => {
    const { fields, fieldSources } = mergeFields({
      pdf: { vendor: 'Acme', total: 1000, lineItems: [item], currency: 'USD' },
      llm: { vendor: '  ', total: 0, lineItems: [], currency: null, invoiceNumber: 'INV-1' },
    });
    expect(fields.vendor).toBe('Acme');
    expect(fields.total).toBe(1000);
    expect(fields.lineItems).toEqual([item]);
    expect(fields.currency).toBe('USD');
    expect(fields.invoiceNumber).toBe('INV-1');
    expect(fieldSources).toEqual({
      vendor: 'pdf', total: 'pdf', lineItems: 'pdf', currency: 'pdf', invoiceNumber: 'llm',
    });
  });

  it('prefers structured over pdf over llm when all are present', () => {
    const { fields, fieldSources } = mergeFields({
      llm: { vendor: 'C', currency: 'EUR' },
      pdf: { vendor: 'B', currency: 'GBP' },
      structured: { vendor: 'A' },
    });
    expect(fields.vendor).toBe('A');
    expect(fields.currency).toBe('GBP');
    expect(fieldSources).toEqual({ vendor: 'structured', currency: 'pdf' });
  });

  it('returns null / [] and no provenance entry for fields nobody supplied', () => {
    const { fields, fieldSources } = mergeFields({ llm: { vendor: '' } });
    expect(fields).toEqual({
      vendor: null, invoiceNumber: null, issueDate: null, currency: null, lineItems: [], total: null,
    });
    expect(fieldSources).toEqual({});
  });
});
