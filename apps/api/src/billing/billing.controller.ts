import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { checkoutSchema } from '@rakan/shared';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { AllowWhenSuspended, Auth, Meta, PlatformAdminOnly, Public, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { BillingService } from './billing.service';

/** A company's subscription payments. Open to suspended companies so they can pay. */
@AllowWhenSuspended()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermission('tenant.settings.read')
  @Get()
  overview(@Auth() auth: TenantAuthContext) {
    return this.billing.overview(auth);
  }

  /** Owners only (tenant.settings.update). The amount comes from the plan price on the server. */
  @RequirePermission('tenant.settings.update')
  @Post('checkout')
  checkout(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>, @Meta() meta: RequestMeta) {
    return this.billing.checkout(auth, body, meta);
  }

  @RequirePermission('tenant.settings.read')
  @Get('invoices/:id')
  invoice(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.billing.invoice(auth, id);
  }

  @RequirePermission('tenant.settings.read')
  @HttpCode(200)
  @Post('invoices/:id/verify')
  verify(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.billing.verify(auth, id);
  }
}

/** Notifications from Moyasar. Never trusted on their own: each one triggers a check with Moyasar's API. */
@Public()
@Controller('public/billing/moyasar')
export class MoyasarHooksController {
  constructor(private readonly billing: BillingService) {}

  @HttpCode(200)
  @Post('callback')
  callback(@Body() body: unknown) {
    return this.billing.callback(body);
  }

  @HttpCode(200)
  @Post('webhook')
  webhook(@Body() body: unknown) {
    return this.billing.webhook(body);
  }
}

@PlatformAdminOnly()
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('invoices')
  invoices(@Query('tenantId') tenantId?: string) {
    return this.billing.platformInvoices(tenantId && /^[0-9a-f-]{36}$/.test(tenantId) ? tenantId : undefined);
  }
}
