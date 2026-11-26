import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

/** `transient` errors are worth retrying; the rest (document missing, bad request) would fail the same way again. */
export class ExtractorError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** Asks a tier's worker to process one document. The worker reports its result through the callback endpoint. */
@Injectable()
export class Extractors {
  private readonly urls = { 1: process.env.EXTRACTOR_TIER1_URL, 2: process.env.EXTRACTOR_TIER2_URL };
  private readonly timeoutMs = Number(process.env.EXTRACTOR_TIMEOUT_MS ?? 120_000); // must outlast the Tier 2 worker's one 60 s model call plus fetch and render

  async run(tier: 1 | 2, documentId: string): Promise<void> {
    const url = this.urls[tier];
    if (!url) throw new ExtractorError(`EXTRACTOR_TIER${tier}_URL is not set`, false);
    const body = JSON.stringify({ documentId });
    const signature = createHmac('sha256', process.env.HMAC_SECRET ?? '').update(body).digest('hex');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signature },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ExtractorError(`tier ${tier} unreachable: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const transient = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new ExtractorError(`tier ${tier} answered ${res.status}`, transient);
    }
  }
}
