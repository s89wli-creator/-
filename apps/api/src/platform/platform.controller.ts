import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { planSchema, planUpdateSchema, subscriptionUpdateSchema, tenantListQuerySchema } from '@rakan/shared';
import { z } from 'zod';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, PlatformAdminOnly, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformService } from './platform.service';

/** Platform console: Rakan operators only (see PermissionsGuard). Aggregates and metadata — no company content. */
@PlatformAdminOnly()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('overview')
  overview() {
    return this.platform.overview();
  }

  @Get('tenants')
  tenants(@Query(new ZodPipe(tenantListQuerySchema)) q: z.infer<typeof tenantListQuerySchema>) {
    return this.platform.tenants(q);
  }

  @Get('tenants/:id')
  tenant(@Param('id', UuidPipe) id: string) {
    return this.platform.tenant(id);
  }

  @Patch('tenants/:id/subscription')
  subscription(
    @Auth() auth: AuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(subscriptionUpdateSchema)) body: z.infer<typeof subscriptionUpdateSchema>,
    @Meta() meta: RequestMeta,
  ) {
    return this.platform.updateSubscription(auth, id, body, meta);
  }

  @Get('plans')
  plans() {
    return this.platform.plans();
  }

  @Post('plans')
  createPlan(@Auth() auth: AuthContext, @Body(new ZodPipe(planSchema)) body: z.infer<typeof planSchema>, @Meta() meta: RequestMeta) {
    return this.platform.createPlan(auth, body, meta);
  }

  @Patch('plans/:id')
  updatePlan(@Auth() auth: AuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(planUpdateSchema)) body: z.infer<typeof planUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.platform.updatePlan(auth, id, body, meta);
  }

  @Get('audit')
  audit() {
    return this.platform.auditLog();
  }
}

/** A company's own plan and usage (owner and managers). */
@Controller('tenant')
export class TenantPlanController {
  constructor(private readonly platform: PlatformService) {}

  @RequirePermission('tenant.settings.read')
  @Get('plan')
  plan(@Auth() auth: TenantAuthContext) {
    return this.platform.ownPlan(auth);
  }
}
