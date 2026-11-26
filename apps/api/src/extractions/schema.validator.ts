import { BadRequestException, Injectable } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Field, InvoiceFields, Source } from '../common/merge';

export interface Payload extends InvoiceFields {
  documentId: string;
  extractionTier: 1 | 2;
  coverageScore: number;
  status: string;
  fieldSources: Partial<Record<Field, Source>>;
  usage?: { inputTokens: number; outputTokens: number };
}

const SPEC_PATH = process.env.SPEC_PATH ?? path.resolve(__dirname, '../../../../spec/extraction.yaml');

@Injectable()
export class SchemaValidator {
  private readonly validate: ValidateFunction;

  constructor() {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    ajv.addSchema(parse(readFileSync(SPEC_PATH, 'utf8')), 'spec');
    this.validate = ajv.compile({ $ref: 'spec#/components/schemas/Extraction' });
  }

  extraction(body: unknown, tier: 1 | 2): Payload {
    if (!this.validate(body)) {
      throw new BadRequestException(this.validate.errors!.map((e) => `${e.instancePath || '/'} ${e.message}`));
    }
    const payload = body as unknown as Payload;
    if (payload.extractionTier !== tier) throw new BadRequestException(`extractionTier must be ${tier} on this route`);
    return payload;
  }
}
