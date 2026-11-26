import { Module } from '@nestjs/common';
import { Db } from './db/db';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { ExtractionsController } from './extractions/extractions.controller';
import { ResultsController } from './extractions/results.controller';
import { MetricsController } from './metrics/metrics.controller';
import { ExtractionsService } from './extractions/extractions.service';
import { SchemaValidator } from './extractions/schema.validator';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { Extractors } from './runner/extractors';
import { RunnerService } from './runner/runner.service';

@Module({
  controllers: [JobsController, ExtractionsController, ResultsController, DocumentsController, MetricsController],
  providers: [Db, JobsService, ExtractionsService, SchemaValidator, DocumentsService, Extractors, RunnerService],
})
export class AppModule {}
