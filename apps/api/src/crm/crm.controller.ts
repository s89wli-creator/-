import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  accountQuerySchema, accountSchema, accountUpdateSchema, contactSchema, customFieldSchema, dashboardQuerySchema, dncSchema,
  importMappingSchema, importRowResolutionSchema, moveStageSchema, noteSchema, opportunitySchema, opportunityUpdateSchema,
  outcomeReasonSchema, pipelineSchema, taskQuerySchema, taskSchema, taskUpdateSchema, trackSchema, visitOutcomeSchema,
  visitQuerySchema, visitRescheduleSchema, visitSchema, geoSchema,
  type AccountQuery,
} from '@rakan/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, RequirePermission } from '../common/decorators';
import { badRequest } from '../common/errors';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { AccountsService } from './accounts.service';
import { ImportsService } from './imports.service';
import { OpportunitiesService } from './opportunities.service';
import { ReportsService } from './reports.service';
import { CrmSettingsService } from './settings.service';
import { toCsv, toXlsx } from './spreadsheet';
import { TasksService } from './tasks.service';
import { VisitsService } from './visits.service';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

@Controller('crm')
export class CrmSettingsController {
  constructor(private readonly settings: CrmSettingsService) {}

  // Readable by anyone who can see accounts (needed to render stages, tracks and custom fields).
  @RequirePermission('crm.account.read')
  @Get('settings')
  get(@Auth() auth: TenantAuthContext) {
    return this.settings.get(auth);
  }

  @RequirePermission('crm.settings.manage')
  @Post('tracks')
  createTrack(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(trackSchema)) body: z.infer<typeof trackSchema>, @Meta() meta: RequestMeta) {
    return this.settings.createTrack(auth, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Patch('tracks/:id')
  updateTrack(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(trackSchema)) body: z.infer<typeof trackSchema>, @Meta() meta: RequestMeta) {
    return this.settings.updateTrack(auth, id, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Put('pipelines/:id')
  updatePipeline(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(pipelineSchema)) body: z.infer<typeof pipelineSchema>, @Meta() meta: RequestMeta) {
    return this.settings.updatePipeline(auth, id, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Post('reasons')
  createReason(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(outcomeReasonSchema)) body: z.infer<typeof outcomeReasonSchema>, @Meta() meta: RequestMeta) {
    return this.settings.createReason(auth, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Patch('reasons/:id')
  updateReason(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(z.object({ label: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional() }))) body: { label?: string; isActive?: boolean },
    @Meta() meta: RequestMeta,
  ) {
    return this.settings.updateReason(auth, id, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Post('custom-fields')
  createCustomField(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(customFieldSchema)) body: z.infer<typeof customFieldSchema>, @Meta() meta: RequestMeta) {
    return this.settings.createCustomField(auth, body, meta);
  }

  @RequirePermission('crm.settings.manage')
  @Delete('custom-fields/:id')
  deleteCustomField(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.settings.deleteCustomField(auth, id, meta);
  }
}

const EXPORT_HEADERS = [
  'الاسم', 'الاسم القانوني', 'السجل التجاري', 'الرقم الضريبي', 'الموقع', 'الهاتف', 'النشاط', 'المنطقة', 'المدينة', 'العنوان',
  'المسار', 'المسؤول', 'الحالة', 'المصدر', 'تاريخ الإنشاء',
];

@Controller('crm/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @RequirePermission('crm.account.read')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(accountQuerySchema)) q: AccountQuery) {
    return this.accounts.list(auth, q);
  }

  @RequirePermission('crm.export')
  @Get('export')
  async export(
    @Auth() auth: TenantAuthContext,
    @Query(new ZodPipe(accountQuerySchema.partial().extend({ format: z.enum(['csv', 'xlsx']).default('xlsx') }))) q: Partial<AccountQuery> & { format: 'csv' | 'xlsx' },
    @Meta() meta: RequestMeta,
    @Res() res: Response,
  ) {
    const { format, page: _p, pageSize: _s, ...filters } = q;
    const rows = await this.accounts.exportRows(auth, filters, meta);
    const data = rows.map(({ a, ownerName, trackName }) => [
      a.name, a.legalName, a.crNumber, a.vatNumber, a.websiteDomain, a.phone, a.industry, a.region, a.city, a.address,
      trackName, ownerName, a.status, a.leadSource, a.createdAt.toISOString().slice(0, 10),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="accounts-${stamp}.csv"`);
      res.send(toCsv(EXPORT_HEADERS, data));
    } else {
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="accounts-${stamp}.xlsx"`);
      res.send(await toXlsx('العملاء', EXPORT_HEADERS, data));
    }
  }

  @RequirePermission('crm.account.write')
  @Post()
  create(
    @Auth() auth: TenantAuthContext,
    @Body(new ZodPipe(accountSchema.extend({ force: z.boolean().optional() }))) body: z.infer<typeof accountSchema> & { force?: boolean },
    @Meta() meta: RequestMeta,
  ) {
    const { force, ...input } = body;
    return this.accounts.create(auth, input, !!force, meta);
  }

  @RequirePermission('crm.account.read')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.accounts.get(auth, id);
  }

  @RequirePermission('crm.account.write')
  @Patch(':id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(accountUpdateSchema)) body: z.infer<typeof accountUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.accounts.update(auth, id, body, meta);
  }

  @RequirePermission('crm.account.delete')
  @HttpCode(204)
  @Delete(':id')
  remove(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.accounts.remove(auth, id, meta);
  }

  @RequirePermission('crm.account.read')
  @Get(':id/contacts')
  contacts(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.accounts.listContacts(auth, id);
  }

  @RequirePermission('crm.account.write')
  @Post(':id/contacts')
  createContact(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>, @Meta() meta: RequestMeta) {
    return this.accounts.createContact(auth, id, body, meta);
  }

  @RequirePermission('crm.account.read')
  @Get(':id/notes')
  notes(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.accounts.listNotes(auth, id);
  }

  @RequirePermission('crm.account.write')
  @Post(':id/notes')
  createNote(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(noteSchema)) body: { body: string }, @Meta() meta: RequestMeta) {
    return this.accounts.createNote(auth, id, body.body, meta);
  }

  @RequirePermission('crm.account.read')
  @Get(':id/timeline')
  timeline(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.accounts.timeline(auth, id);
  }
}

@Controller('crm')
export class ContactsNotesController {
  constructor(private readonly accounts: AccountsService) {}

  @RequirePermission('crm.account.write')
  @Patch('contacts/:id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(contactSchema.partial())) body: Partial<z.infer<typeof contactSchema>>, @Meta() meta: RequestMeta) {
    return this.accounts.updateContact(auth, id, body, meta);
  }

  @RequirePermission('crm.account.write')
  @Put('contacts/:id/dnc')
  dnc(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(dncSchema)) body: z.infer<typeof dncSchema>, @Meta() meta: RequestMeta) {
    return this.accounts.setDnc(auth, id, body, meta);
  }

  @RequirePermission('crm.account.write')
  @HttpCode(204)
  @Delete('contacts/:id')
  removeContact(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.accounts.removeContact(auth, id, meta);
  }

  @RequirePermission('crm.account.write')
  @HttpCode(204)
  @Delete('notes/:id')
  removeNote(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.accounts.removeNote(auth, id, meta);
  }
}

@Controller('crm/opportunities')
export class OpportunitiesController {
  constructor(private readonly opps: OpportunitiesService) {}

  @RequirePermission('crm.opportunity.read')
  @Get()
  list(
    @Auth() auth: TenantAuthContext,
    @Query(new ZodPipe(z.object({ pipelineId: z.string().uuid().optional(), accountId: z.string().uuid().optional(), ownerMembershipId: z.string().uuid().optional(), status: z.enum(['open', 'closed', 'all']).default('all') })))
    q: { pipelineId?: string; accountId?: string; ownerMembershipId?: string; status: 'open' | 'closed' | 'all' },
  ) {
    return this.opps.list(auth, q);
  }

  @RequirePermission('crm.opportunity.write')
  @Post()
  create(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(opportunitySchema)) body: z.infer<typeof opportunitySchema>, @Meta() meta: RequestMeta) {
    return this.opps.create(auth, body, meta);
  }

  @RequirePermission('crm.opportunity.read')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.opps.get(auth, id);
  }

  @RequirePermission('crm.opportunity.write')
  @Patch(':id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(opportunityUpdateSchema)) body: z.infer<typeof opportunityUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.opps.update(auth, id, body, meta);
  }

  @RequirePermission('crm.opportunity.write')
  @HttpCode(200)
  @Post(':id/stage')
  move(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(moveStageSchema)) body: z.infer<typeof moveStageSchema>, @Meta() meta: RequestMeta) {
    return this.opps.moveStage(auth, id, body, meta);
  }

  @RequirePermission('crm.account.delete')
  @HttpCode(204)
  @Delete(':id')
  remove(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.opps.remove(auth, id, meta);
  }
}

@Controller('crm/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @RequirePermission('crm.task.read')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(taskQuerySchema)) q: z.infer<typeof taskQuerySchema>) {
    return this.tasks.list(auth, q);
  }

  @RequirePermission('crm.task.write')
  @Post()
  create(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(taskSchema)) body: z.infer<typeof taskSchema>, @Meta() meta: RequestMeta) {
    return this.tasks.create(auth, body, meta);
  }

  @RequirePermission('crm.task.write')
  @Patch(':id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(taskUpdateSchema)) body: z.infer<typeof taskUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.tasks.update(auth, id, body, meta);
  }
}

@Controller('crm/visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @RequirePermission('crm.visit.read')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(visitQuerySchema)) q: z.infer<typeof visitQuerySchema>) {
    return this.visits.list(auth, q);
  }

  @RequirePermission('crm.visit.write')
  @Post()
  create(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(visitSchema)) body: z.infer<typeof visitSchema>, @Meta() meta: RequestMeta) {
    return this.visits.create(auth, body, meta);
  }

  @RequirePermission('crm.visit.read')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.visits.get(auth, id);
  }

  @RequirePermission('crm.visit.write')
  @Patch(':id')
  reschedule(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(visitRescheduleSchema)) body: z.infer<typeof visitRescheduleSchema>, @Meta() meta: RequestMeta) {
    return this.visits.reschedule(auth, id, body, meta);
  }

  @RequirePermission('crm.visit.write')
  @HttpCode(200)
  @Post(':id/check-in')
  checkIn(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(geoSchema)) body: z.infer<typeof geoSchema>, @Meta() meta: RequestMeta) {
    return this.visits.checkIn(auth, id, body, meta);
  }

  @RequirePermission('crm.visit.write')
  @HttpCode(200)
  @Post(':id/complete')
  complete(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(visitOutcomeSchema.merge(geoSchema.pick({ lat: true, lng: true })))) body: z.infer<typeof visitOutcomeSchema> & { lat?: number; lng?: number },
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.complete(auth, id, body, meta);
  }

  @RequirePermission('crm.visit.write')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.visits.cancel(auth, id, meta);
  }
}

@Controller('crm/imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @RequirePermission('crm.import')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } }))
  upload(@Auth() auth: TenantAuthContext, @UploadedFile() file: Express.Multer.File | undefined, @Meta() meta: RequestMeta) {
    if (!file?.buffer?.length) throw badRequest('NO_FILE', 'Attach a .xlsx or .csv file');
    return this.imports.upload(auth, { originalname: Buffer.from(file.originalname, 'latin1').toString('utf8'), buffer: file.buffer }, meta);
  }

  @RequirePermission('crm.import')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.imports.get(auth, id);
  }

  @RequirePermission('crm.import')
  @Put(':id/mapping')
  map(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(importMappingSchema)) body: z.infer<typeof importMappingSchema>, @Meta() meta: RequestMeta) {
    return this.imports.setMapping(auth, id, body, meta);
  }

  @RequirePermission('crm.import')
  @Get(':id/rows')
  rows(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(z.object({ filter: z.enum(['all', 'duplicates', 'invalid', 'warnings', 'create']).default('all'), page: z.coerce.number().int().min(1).default(1) })))
    q: { filter: 'all' | 'duplicates' | 'invalid' | 'warnings' | 'create'; page: number },
  ) {
    return this.imports.rows(auth, id, q);
  }

  @RequirePermission('crm.import')
  @Patch(':id/rows/:rowId')
  resolve(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Param('rowId', ParseIntPipe) rowId: number,
    @Body(new ZodPipe(importRowResolutionSchema)) body: z.infer<typeof importRowResolutionSchema>,
  ) {
    return this.imports.setResolution(auth, id, rowId, body.resolution);
  }

  @RequirePermission('crm.import')
  @HttpCode(200)
  @Post(':id/execute')
  execute(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.imports.execute(auth, id, meta);
  }

  @RequirePermission('crm.import')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.imports.cancel(auth, id, meta);
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission('reports.read')
  @Get('dashboard')
  dashboard(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(dashboardQuerySchema)) q: z.infer<typeof dashboardQuerySchema>) {
    return this.reports.dashboard(auth, q);
  }
}
