import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { recordingStartSchema, transcriptSchema, type AccountDto, type ContactDto, type TaskDto, type VisitBriefDto, type VisitDto } from '@rakan/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, RequirePermission, type RakanRequest } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { AgentsService } from '../ai/agents.service';
import { AccountsService } from '../crm/accounts.service';
import { TasksService } from '../crm/tasks.service';
import { VisitsService } from '../crm/visits.service';
import { RecordingsService } from './recordings.service';

export interface FieldPackDto {
  generatedAt: string;
  visits: VisitDto[];
  tasks: TaskDto[];
  accounts: Record<string, AccountDto & { contacts: ContactDto[] }>;
  briefs: Record<string, VisitBriefDto>;
}

/** Riyadh midnight today (the field day), as a Date. */
function startOfFieldDay(now = new Date()): Date {
  const riyadh = new Date(now.getTime() + 3 * 3600_000);
  riyadh.setUTCHours(0, 0, 0, 0);
  return new Date(riyadh.getTime() - 3 * 3600_000);
}

@Controller('field')
export class FieldController {
  constructor(
    private readonly visits: VisitsService,
    private readonly tasks: TasksService,
    private readonly accounts: AccountsService,
    private readonly agents: AgentsService,
  ) {}

  /**
   * Everything a rep needs for today and the next two days, in one request, so the phone can work offline:
   * own visits, their accounts and contacts, the latest visit briefs, and open tasks.
   */
  @RequirePermission('crm.visit.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('today')
  async today(@Auth() auth: TenantAuthContext): Promise<FieldPackDto> {
    const from = startOfFieldDay();
    const visits = await this.visits.list(auth, { from, to: new Date(from.getTime() + 3 * 86400_000), repMembershipId: auth.membershipId });
    const own = visits.filter((v) => v.repMembershipId === auth.membershipId && v.status !== 'cancelled');
    const tasks = auth.permissions.includes('crm.task.read') ? await this.tasks.list(auth, { view: 'mine', limit: 100 }) : [];
    const accounts: FieldPackDto['accounts'] = {};
    for (const id of [...new Set(own.map((v) => v.accountId))]) {
      try {
        accounts[id] = { ...(await this.accounts.get(auth, id)), contacts: await this.accounts.listContacts(auth, id) };
      } catch {
        // Account outside the rep's read scope: the visit itself still carries name and city.
      }
    }
    const briefs: FieldPackDto['briefs'] = {};
    if (auth.permissions.includes('ai.use')) {
      for (const v of own.filter((x) => x.status !== 'completed')) {
        const b = await this.agents.latestBrief(auth, v.id).catch(() => null);
        if (b) briefs[v.id] = b;
      }
    }
    return { generatedAt: new Date().toISOString(), visits: own, tasks, accounts, briefs };
  }
}

@Controller('crm')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @RequirePermission('crm.visit.read')
  @Get('visits/:id/recordings')
  list(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.recordings.list(auth, id);
  }

  @RequirePermission('crm.visit.write')
  @Post('visits/:id/recordings')
  start(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(recordingStartSchema)) body: z.infer<typeof recordingStartSchema>, @Meta() meta: RequestMeta) {
    return this.recordings.start(auth, id, body, meta);
  }

  @RequirePermission('crm.visit.write')
  @Put('recordings/:id/chunks/:n')
  chunk(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Param('n', ParseIntPipe) n: number, @Req() req: RakanRequest) {
    return this.recordings.putChunk(auth, id, n, req.body as Buffer);
  }

  @RequirePermission('crm.visit.write')
  @HttpCode(200)
  @Post('recordings/:id/complete')
  complete(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.recordings.complete(auth, id, meta);
  }

  @RequirePermission('crm.visit.read')
  @Get('recordings/:id/audio')
  async audio(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { data, mimeType } = await this.recordings.audio(auth, id);
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(data, { type: mimeType, length: data.length });
  }

  @RequirePermission('crm.visit.write')
  @Patch('recordings/:id/transcript')
  transcript(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(transcriptSchema)) body: { transcript: string }, @Meta() meta: RequestMeta) {
    return this.recordings.setTranscript(auth, id, body.transcript, meta);
  }

  @RequirePermission('crm.visit.write')
  @HttpCode(204)
  @Delete('recordings/:id')
  async remove(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    await this.recordings.remove(auth, id, meta);
  }
}
