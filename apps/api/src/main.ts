import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Db } from './db/db';
import { migrate } from './db/migrate';

async function main() {
  const app = await NestFactory.create(AppModule, { rawBody: true }); // rawBody: the HMAC guard signs raw bytes
  app.enableShutdownHooks();
  await migrate(app.get(Db).pool);
  await app.listen(process.env.PORT ?? 3000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
