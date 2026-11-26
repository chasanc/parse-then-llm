import { BadRequestException, Controller, Get, Inject, Param, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { HmacGuard } from '../common/hmac.guard';
import { DocumentsService } from './documents.service';

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new BadRequestException('invalid documentId');
  return id;
};

@Controller()
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  // The body is the raw PDF (no body parser handles application/pdf, so the request stream is untouched).
  @Put('documents/:documentId')
  @UseGuards(ApiKeyGuard)
  upload(@Param('documentId') id: string, @Req() req: Request, @Query('replace') replace?: string) {
    return this.docs.save(checkId(id), req, replace === 'true');
  }

  // Extractors fetch the PDF here; the signature covers the URL path since a GET has no body.
  @Get('internal/documents/:documentId')
  @UseGuards(HmacGuard)
  async download(@Param('documentId') id: string, @Res() res: Response) {
    const { stream, size, sha256 } = await this.docs.open(checkId(id));
    // Workers echo this hash on their callback, so a result for bytes that were replaced meanwhile can be dropped.
    res.status(200).type('application/pdf').set({ 'content-length': String(size), 'x-document-sha256': sha256 });
    stream.pipe(res);
  }
}
