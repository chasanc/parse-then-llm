import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class Db implements OnApplicationShutdown {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  constructor() {
    // An idle client dying (database restart, failover) emits 'error'; unhandled, it kills the process.
    this.pool.on('error', (err) => new Logger(Db.name).warn(`idle client error: ${err.message}`));
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
