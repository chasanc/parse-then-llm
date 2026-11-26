import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const fixtures = path.join(root, 'eval/fixtures');

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(parse(readFileSync(path.join(root, 'spec/extraction.yaml'), 'utf8')), 'spec');
const validate = ajv.compile({ $ref: 'spec#/components/schemas/Extraction' });

const names = (dir: string, ext: string) =>
  readdirSync(path.join(fixtures, dir)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).sort();
const expectedNames = names('expected', '.json');

describe('eval fixtures', () => {
  it('has a PDF for every expected JSON and vice versa', () => {
    expect(names('pdf', '.pdf')).toEqual(expectedNames);
    expect(expectedNames.length).toBeGreaterThanOrEqual(10);
  });

  it.each(expectedNames)('%s validates against the contract and its own arithmetic', (name) => {
    const e = JSON.parse(readFileSync(path.join(fixtures, 'expected', `${name}.json`), 'utf8'));
    expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
    expect(e.documentId).toBe(name);
    for (const li of e.lineItems) expect(li.amount).toBe(li.quantity * li.unitPrice);
    if (e.status === 'failed') return;
    const sum = e.lineItems.reduce((s: number, li: { amount: number }) => s + li.amount, 0);
    expect(sum === e.total).toBe(e.status !== 'needs_review');
  });
});
