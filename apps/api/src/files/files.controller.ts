import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ATTACHMENT_MAX_BYTES, attachmentListQuerySchema, attachmentUploadSchema, pushSubscriptionSchema, pushUnsubscribeSchema } from '@rakan/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { AttachmentsService } from './attachments.service';
import { PushService } from './push.service';
import { BrandingService, LOGO_MAX_BYTES } from './branding.service';

/** Attachments. The route needs crm.account.*; the service also checks the parent record's own permission and scope. */
@Controller('crm/attachments')
export class AttachmentsController {
  constructor(private readonly files: AttachmentsService) {}

  @RequirePermission('crm.account.read')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(attachmentListQuerySchema)) q: z.infer<typeof attachmentListQuerySchema>) {
    return this.files.list(auth, q.entityType, q.entityId);
  }

  @RequirePermission('crm.account.write')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 5 } }))
  upload(
    @Auth() auth: TenantAuthContext,
    @Body(new ZodPipe(attachmentUploadSchema)) body: z.infer<typeof attachmentUploadSchema>,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Meta() meta: RequestMeta,
  ) {
    return this.files.upload(auth, body.entityType, body.entityId, file, meta);
  }

  @RequirePermission('crm.account.read')
  @Get(':id/file')
  async file(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const f = await this.files.download(auth, id);
    res.setHeader('Cache-Control', 'private, no-store');
    // Always a download (never rendered inside the app's origin); ASCII fallback name + the real UTF-8 name.
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    const ext = f.filename.includes('.') ? f.filename.split('.').pop()!.replace(/[^A-Za-z0-9]/g, '') : 'bin';
    return new StreamableFile(f.data, {
      type: f.mimeType, length: f.data.length,
      disposition: `attachment; filename="file.${ext}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    });
  }

  @RequirePermission('crm.account.write')
  @HttpCode(204)
  @Delete(':id')
  remove(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.files.remove(auth, id, meta);
  }
}

/** The signed-in person's devices for push notifications. */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @RequirePermission('tenant.settings.read')
  @Get()
  config(@Auth() auth: TenantAuthContext) {
    return this.push.getConfig(auth);
  }

  @RequirePermission('tenant.settings.read')
  @HttpCode(200)
  @Post('subscriptions')
  subscribe(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(pushSubscriptionSchema)) body: z.infer<typeof pushSubscriptionSchema>, @Headers('user-agent') ua?: string) {
    return this.push.subscribe(auth, body, ua?.slice(0, 300) ?? null);
  }

  @RequirePermission('tenant.settings.read')
  @HttpCode(204)
  @Post('subscriptions/remove')
  unsubscribe(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(pushUnsubscribeSchema)) body: z.infer<typeof pushUnsubscribeSchema>) {
    return this.push.unsubscribe(auth, body.endpoint);
  }
}

/** Company logo (proposals). Any member can see it; owners change it. */
@Controller('tenant/logo')
export class LogoController {
  constructor(private readonly branding: BrandingService) {}

  @RequirePermission('tenant.settings.read')
  @Get()
  async get(@Auth() auth: TenantAuthContext, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const l = await this.branding.get(auth.tenantId);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return new StreamableFile(l.data, { type: l.mimeType, length: l.data.length });
  }

  @RequirePermission('tenant.settings.update')
  @HttpCode(200)
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 2 } }))
  set(@Auth() auth: TenantAuthContext, @UploadedFile() file: Express.Multer.File | undefined, @Meta() meta: RequestMeta) {
    return this.branding.set(auth, file, meta);
  }

  @RequirePermission('tenant.settings.update')
  @HttpCode(204)
  @Delete()
  remove(@Auth() auth: TenantAuthContext, @Meta() meta: RequestMeta) {
    return this.branding.remove(auth, meta);
  }
}
