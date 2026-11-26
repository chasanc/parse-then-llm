import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ExtractionsService } from './extractions.service';

const STATUSES = ['verified', 'ai_enhanced', 'needs_review', 'failed'];

@Controller('extractions')
@UseGuards(ApiKeyGuard)
export class ResultsController {
  constructor(@Inject(ExtractionsService) private readonly extractions: ExtractionsService) {}

  /** GET /extractions?status=needs_review&limit=50&after=<documentId> */
  @Get()
  list(@Query('status') status = 'needs_review', @Query('limit') limit = '50', @Query('after') after?: string) {
    if (!STATUSES.includes(status)) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    return this.extractions.list(status, Math.min(Math.max(Number(limit) || 50, 1), 200), after);
  }

  @Get(':documentId')
  async get(@Param('documentId') documentId: string) {
    const result = await this.extractions.get(documentId);
    if (!result) throw new NotFoundException();
    return result;
  }
}
