import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { Db } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { Extractors } from '../../src/runner/extractors';

const SECRET = randomBytes(16).toString('hex'); // fresh per run, never a real credential
const API_KEY = randomBytes(16).toString('hex');
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5440/postgres';

export interface TestApp {
  app: INestApplication;
  pool: Pool;
  /** Supertest client that sends the API key. */
  http: () => ReturnType<typeof request>;
  /** Same server, no credentials. */
  anonymous: () => ReturnType<typeof request>;
  apiKey: string;
  /** POST a signed JSON body. */
  signed: (path: string, body: unknown, signature?: string) => request.Test;
  sign: (raw: string) => string;
  stop: () => Promise<void>;
}

// Each spec file gets its own throwaway database, dropped on stop. Never point this at a real database.
export async function startTestApp(opts: { extractors?: Extractors } = {}): Promise<TestApp> {
  const admin = new Pool({ connectionString: ADMIN_URL });
  const dbName = `ptl_test_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.HMAC_SECRET = SECRET;
  process.env.PTL_API_KEY = API_KEY;
  const docsDir = mkdtempSync(path.join(tmpdir(), 'ptl-docs-'));
  process.env.DOCUMENTS_DIR = docsDir;
  process.env.MAX_DOCUMENT_BYTES = '200000'; // small, so the size-limit test stays cheap

  process.env.RUNNER_ENABLED = 'false'; // specs drive the runner by hand
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.extractors) builder.overrideProvider(Extractors).useValue(opts.extractors);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  const pool = app.get(Db).pool;
  await migrate(pool);

  const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('hex');
  return {
    app,
    pool,
    sign,
    apiKey: API_KEY,
    anonymous: () => request(app.getHttpServer()),
    http: () => {
      const agent = request(app.getHttpServer());
      const authed = (m: 'get' | 'put' | 'post') => (url: string) => agent[m](url).set('authorization', `Bearer ${API_KEY}`);
      return { get: authed('get'), put: authed('put'), post: authed('post') } as unknown as typeof agent;
    },
    signed: (path, body, signature) => {
      const raw = JSON.stringify(body);
      return request(app.getHttpServer())
        .post(path)
        .set('content-type', 'application/json')
        .set('x-signature', signature ?? sign(raw))
        .send(raw);
    },
    stop: async () => {
      await app.close();
      await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await admin.end();
      rmSync(docsDir, { recursive: true, force: true });
    },
  };
}
