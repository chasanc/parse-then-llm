import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(ApiKeyGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    const job = await this.jobs.get(id);
    if (!job) throw new NotFoundException();
    return job;
  }

  @Post()
  async create(@Body() body: Record<string, unknown> | undefined, @Res({ passthrough: true }) res: Response) {
    const { documentId, documentHash, idempotencyKey } = body ?? {};
    if (typeof documentId !== 'string' || !documentId) throw new BadRequestException('documentId is required');
    if (typeof documentHash !== 'string' || !/^[a-f0-9]{64}$/.test(documentHash)) {
      throw new BadRequestException('documentHash must be a lowercase sha256 hex string');
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey)) {
      throw new BadRequestException('idempotencyKey must be a non-empty string');
    }
    const { job, created } = await this.jobs.enqueue(documentId, documentHash, idempotencyKey ?? `${documentId}:${documentHash}`);
    res.status(created ? 201 : 200);
    return job;
  }
}
