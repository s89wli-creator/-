import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
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
import { AgentsService } from './ai/agents.service';
import { AiController, ApprovalsController, BrainController } from './ai/ai.controller';
import { AiSettingsService } from './ai/ai-settings.service';
import { AnthropicProvider } from './ai/anthropic.provider';
import { BrainService } from './ai/brain.service';
import { FakeProvider } from './ai/fake.provider';
import { LLM_PROVIDER, type LlmProvider } from './ai/llm';
import { MessagingService } from './ai/messaging.service';
import { AiRuntimeService } from './ai/runtime.service';
import { ToolGatewayService } from './ai/tool-gateway.service';
import { FieldController, RecordingsController } from './field/field.controller';
import { RecordingsService } from './field/recordings.service';
import { StorageService } from './field/storage.service';
import { PlanService } from './platform/plan.service';
import { PlatformController, TenantPlanController } from './platform/platform.controller';
import { PlatformService } from './platform/platform.service';

function llmProvider(config: AppConfig): LlmProvider {
  const kind = config.AI_PROVIDER ?? (config.ANTHROPIC_API_KEY ? 'anthropic' : 'none');
  if (kind === 'fake') return new FakeProvider();
  return new AnthropicProvider(kind === 'anthropic' ? config.ANTHROPIC_API_KEY : undefined, config.AI_MODEL);
}

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
        VisitsController, ImportsController, ReportsController, AiController, BrainController, ApprovalsController,
        FieldController, RecordingsController, PlatformController, TenantPlanController,
      ],
      providers: [
        DbService, PasswordService, SessionService, MailService, AuditService, SecurityService,
        AuthService, TenantService, TeamService, TerritoryService, FieldCryptoService,
        ScopeService, ActivityService, CrmSettingsService, AccountsService, OpportunitiesService, TasksService, VisitsService,
        ImportsService, ReportsService,
        { provide: LLM_PROVIDER, useValue: llmProvider(config) },
        AiRuntimeService, ToolGatewayService, AiSettingsService, BrainService, AgentsService, MessagingService,
        StorageService, RecordingsService, PlanService, PlatformService,
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
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
