import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from './config';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { CsrfCookieMiddleware, CsrfGuard } from './common/csrf';
import { DbService } from './common/db.service';
import { AUTH_RATE_LIMITED } from './common/decorators';
import { AllExceptionsFilter } from './common/errors';
import { PermissionsGuard, SessionGuard } from './common/guards';
import { HealthController } from './health/health.controller';
import { AuthController } from './identity/auth.controller';
import { AuthService } from './identity/auth.service';
import { MailService } from './identity/mail.service';
import { PasswordService } from './identity/password.service';
import { SecurityService } from './identity/security.service';
import { SessionService } from './identity/session.service';
import { InvitationsController, TeamController } from './team/team.controller';
import { TeamService } from './team/team.service';
import { TerritoryService } from './team/territory.service';
import { TenantController } from './tenancy/tenant.controller';
import { FieldCryptoService } from './common/field-crypto.service';
import { AccountsService } from './crm/accounts.service';
import { ActivityService } from './crm/activity.service';
import {
  AccountsController, ContactsNotesController, CrmSettingsController, ImportsController, OpportunitiesController,
  ReportsController, TasksController, VisitsController,
} from './crm/crm.controller';
import { ImportsService } from './crm/imports.service';
import { OpportunitiesService } from './crm/opportunities.service';
import { ReportsService } from './crm/reports.service';
import { ScopeService } from './crm/scope';
import { CrmSettingsService } from './crm/settings.service';
import { TasksService } from './crm/tasks.service';
import { VisitsService } from './crm/visits.service';
import { TenantService } from './tenancy/tenant.service';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] };
  }
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            genReqId: (req, res) => {
              const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            // Never log credentials or PII-bearing payloads.
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
            serializers: {
              req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
            },
            transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
          },
        }),
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE },
          {
            name: 'auth',
            ttl: 60_000,
            limit: config.AUTH_RATE_LIMIT_PER_MINUTE,
            skipIf: (ctx) => !Reflect.getMetadata(AUTH_RATE_LIMITED, ctx.getHandler()),
          },
        ]),
      ],
      controllers: [
        HealthController, AuthController, TenantController, TeamController, InvitationsController, AuditController,
        CrmSettingsController, AccountsController, ContactsNotesController, OpportunitiesController, TasksController,
        VisitsController, ImportsController, ReportsController,
      ],
      providers: [
        DbService, PasswordService, SessionService, MailService, AuditService, SecurityService,
        AuthService, TenantService, TeamService, TerritoryService, FieldCryptoService,
        ScopeService, ActivityService, CrmSettingsService, AccountsService, OpportunitiesService, TasksService, VisitsService,
        ImportsService, ReportsService,
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // Order matters: rate limit -> CSRF -> session -> permission.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfCookieMiddleware).forRoutes('*path');
  }
}
