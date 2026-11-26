import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { HmacGuard } from '../common/hmac.guard';
import { ExtractionsService } from './extractions.service';
import { SchemaValidator } from './schema.validator';

@Controller('internal/extractions')
@UseGuards(HmacGuard)
export class ExtractionsController {
  constructor(
    @Inject(SchemaValidator) private readonly validator: SchemaValidator,
    @Inject(ExtractionsService) private readonly extractions: ExtractionsService,
  ) {}

  @Post('tier1')
  @HttpCode(204)
  async tier1(@Body() body: unknown, @Headers('x-document-sha256') sha256?: string) {
    await this.extractions.apply(1, this.validator.extraction(body, 1), sha256);
  }

  @Post('tier2')
  @HttpCode(204)
  async tier2(@Body() body: unknown, @Headers('x-document-sha256') sha256?: string) {
    await this.extractions.apply(2, this.validator.extraction(body, 2), sha256);
  }
}
