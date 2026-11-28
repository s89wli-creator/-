import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { JOBS, coachQuerySchema, coachReportListQuerySchema, coachReportRequestSchema, jobUpdateSchema } from '@rakan/shared';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { AllowWhenSuspended, Auth, Meta, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CoachService } from './coach.service';
import { NotificationsService } from './notifications.service';
import { SchedulerService } from './scheduler.service';

const jobParam = z.enum(JOBS);

/** Sales Coach: numbers for everyone (own), the team view for owners/managers, AI reports. */
@Controller('coach')
export class CoachController {
  constructor(private readonly coach: CoachService) {}

  @RequirePermission('reports.read')
  @Get('team')
  team(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(coachQuerySchema)) q: z.infer<typeof coachQuerySchema>) {
    return this.coach.team(auth, q.days);
  }

  @RequirePermission('crm.visit.read')
  @Get('me')
  me(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(coachQuerySchema)) q: z.infer<typeof coachQuerySchema>) {
    return this.coach.mine(auth, q.days);
  }

  /** Own report for anyone with ai.use; someone else's needs reports.read (checked in the service). */
  @RequirePermission('ai.use')
  @Post('reports')
  generate(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(coachReportRequestSchema)) body: z.infer<typeof coachReportRequestSchema>) {
    return this.coach.generate(auth, body);
  }

  @RequirePermission('crm.visit.read')
  @Get('reports')
  reports(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(coachReportListQuerySchema)) q: z.infer<typeof coachReportListQuerySchema>) {
    return this.coach.reports(auth, q.membershipId);
  }

  @RequirePermission('crm.visit.read')
  @Get('reports/:id')
  report(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.coach.report(auth, id);
  }
}

/** Scheduled agents settings (owner and managers). */
@Controller('automation')
export class AutomationController {
  constructor(private readonly scheduler: SchedulerService) {}

  @RequirePermission('crm.settings.manage')
  @Get('jobs')
  jobs(@Auth() auth: TenantAuthContext) {
    return this.scheduler.list(auth);
  }

  @RequirePermission('crm.settings.manage')
  @Patch('jobs/:job')
  update(
    @Auth() auth: TenantAuthContext,
    @Param('job', new ZodPipe(jobParam)) job: z.infer<typeof jobParam>,
    @Body(new ZodPipe(jobUpdateSchema)) body: z.infer<typeof jobUpdateSchema>,
    @Meta() meta: RequestMeta,
  ) {
    return this.scheduler.update(auth, job, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @HttpCode(200)
  @Post('jobs/:job/run')
  run(@Auth() auth: TenantAuthContext, @Param('job', new ZodPipe(jobParam)) job: z.infer<typeof jobParam>, @Meta() meta: RequestMeta) {
    return this.scheduler.runNow(auth, job, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Get('runs')
  runs(@Auth() auth: TenantAuthContext) {
    return this.scheduler.runs(auth);
  }
}

/** The signed-in person's own notifications (still readable while the company is suspended: payment receipts). */
@AllowWhenSuspended()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notes: NotificationsService) {}

  @RequirePermission('tenant.settings.read')
  @Get()
  list(@Auth() auth: TenantAuthContext) {
    return this.notes.list(auth);
  }

  @RequirePermission('tenant.settings.read')
  @HttpCode(204)
  @Post(':id/read')
  read(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.notes.read(auth, id);
  }

  @RequirePermission('tenant.settings.read')
  @HttpCode(204)
  @Post('read-all')
  readAll(@Auth() auth: TenantAuthContext) {
    return this.notes.readAll(auth);
  }
}
