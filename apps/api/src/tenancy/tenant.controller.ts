import { Body, Controller, Get, Patch } from '@nestjs/common';
import { tenantSettingsSchema, type TenantDto, type TenantSettingsInput } from '@rakan/shared';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { TenantService } from './tenant.service';

@Controller('tenant')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @RequirePermission('tenant.settings.read')
  @Get()
  get(@Auth() auth: TenantAuthContext): Promise<TenantDto> {
    return this.tenants.get(auth);
  }

  @RequirePermission('tenant.settings.update')
  @Patch()
  update(
    @Auth() auth: TenantAuthContext,
    @Body(new ZodPipe(tenantSettingsSchema)) body: TenantSettingsInput,
    @Meta() meta: RequestMeta,
  ): Promise<TenantDto> {
    return this.tenants.update(auth, body, meta);
  }
}
