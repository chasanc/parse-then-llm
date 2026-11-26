import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const digest = (s: string) => createHash('sha256').update(s).digest(); // equal length, so timingSafeEqual is safe
export const MIN_KEY_LENGTH = 16;

// shortcut: one shared key for every client, so there is no per-client revocation or audit trail;
// move to per-client keys or OIDC when a second client needs different access.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly key: Buffer;

  constructor() {
    const key = process.env.PTL_API_KEY;
    if (!key) throw new Error('PTL_API_KEY is required');
    // Length only: a guessable placeholder such as 1234567890 must not reach a deployment. openssl rand -hex 32 is fine.
    if (key.length < MIN_KEY_LENGTH) throw new Error(`PTL_API_KEY must be at least ${MIN_KEY_LENGTH} characters; generate one with: openssl rand -hex 32`);
    this.key = digest(key);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const header = ctx.switchToHttp().getRequest<Request>().header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !timingSafeEqual(digest(given), this.key)) throw new UnauthorizedException();
    return true;
  }
}
