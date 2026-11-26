import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

// shortcut: no timestamp or nonce, so a captured request can be replayed. Merging is idempotent
// per ADR 0003, so replay cannot corrupt data; add a signed timestamp before exposing this publicly.
@Injectable()
export class HmacGuard implements CanActivate {
  private readonly secret: string;

  constructor() {
    const secret = process.env.HMAC_SECRET;
    if (!secret) throw new Error('HMAC_SECRET is required');
    this.secret = secret;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const given = Buffer.from(req.header('x-signature') ?? '', 'hex');
    // Signed content is the raw body, or the request path for body-less requests (GET).
    const signed = req.rawBody ?? (req.method === 'GET' ? Buffer.from(req.originalUrl) : undefined);
    const expected = signed && createHmac('sha256', this.secret).update(signed).digest();
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
