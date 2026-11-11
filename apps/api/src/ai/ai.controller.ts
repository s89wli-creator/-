import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  aiSettingsSchema, brainDocumentSchema, brainItemSchema, brainItemUpdateSchema, decisionSchema, draftUpdateSchema,
  assistantMessageSchema, followUpRequestSchema, prospectManualSchema, prospectRejectSchema, prospectSearchSchema, scoreReviewSchema, scoringWeightsSchema,
} from '@rakan/shared';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { AgentsService } from './agents.service';
import { AiSettingsService } from './ai-settings.service';
import { BrainService } from './brain.service';
import { MessagingService } from './messaging.service';
import { ProspectingService } from './prospecting.service';
import { AssistantService } from './assistant.service';
import { ToolGatewayService } from './tool-gateway.service';

const runsQuery = z.object({ agent: z.string().max(40).optional(), entityId: z.string().uuid().optional() });
const approvalsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'execution_failed']).optional() });
const followUpBody = followUpRequestSchema.extend({ visitId: z.string().uuid().optional() });
const prospectsQuery = z.object({ status: z.enum(['pending_review', 'accepted', 'rejected']).optional() });

/** Prospecting agent: proposals only; a person accepts each one before it becomes an account. */
@Controller('ai/prospecting')
export class ProspectingController {
  constructor(private readonly prospecting: ProspectingService) {}

  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('search')
  search(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(prospectSearchSchema)) body: z.infer<typeof prospectSearchSchema>, @Meta() meta: RequestMeta) {
    return this.prospecting.search(auth, body, meta);
  }

  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('from-text')
  fromText(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(prospectManualSchema)) body: z.infer<typeof prospectManualSchema>, @Meta() meta: RequestMeta) {
    return this.prospecting.fromText(auth, body, meta);
  }

  @RequirePermission('ai.use')
  @Get('searches')
  searches(@Auth() auth: TenantAuthContext) {
    return this.prospecting.searches(auth);
  }

  @RequirePermission('ai.use')
  @Get('prospects')
  prospects(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(prospectsQuery)) q: z.infer<typeof prospectsQuery>) {
    return this.prospecting.list(auth, q.status);
  }

  @RequirePermission('crm.account.write')
  @HttpCode(200)
  @Post('prospects/:id/accept')
  accept(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.prospecting.accept(auth, id, meta);
  }

  @RequirePermission('crm.account.write')
  @HttpCode(200)
  @Post('prospects/:id/reject')
  reject(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(prospectRejectSchema)) body: { reason: string }, @Meta() meta: RequestMeta) {
    return this.prospecting.reject(auth, id, body.reason, meta);
  }
}

@Controller('ai')
export class AiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly agents: AgentsService,
    private readonly messaging: MessagingService,
  ) {}

  @RequirePermission('ai.use')
  @Get('status')
  status(@Auth() auth: TenantAuthContext) {
    return this.settings.status(auth);
  }

  @RequirePermission('ai.manage')
  @Get('settings')
  getSettings(@Auth() auth: TenantAuthContext) {
    return this.settings.get(auth);
  }

  @RequirePermission('ai.manage')
  @Patch('settings')
  updateSettings(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(aiSettingsSchema)) body: z.infer<typeof aiSettingsSchema>, @Meta() meta: RequestMeta) {
    return this.settings.update(auth, body, meta);
  }

  @RequirePermission('ai.manage')
  @Put('scoring')
  updateScoring(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(scoringWeightsSchema)) body: z.infer<typeof scoringWeightsSchema>, @Meta() meta: RequestMeta) {
    return this.settings.updateScoring(auth, body, meta);
  }

  @RequirePermission('ai.runs.read')
  @Get('runs')
  runs(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(runsQuery)) q: z.infer<typeof runsQuery>) {
    return this.settings.runs(auth, q);
  }

  @RequirePermission('ai.runs.read')
  @Get('runs/:id')
  run(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.settings.run(auth, id);
  }

  // ---- Lead intelligence
  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('accounts/:id/score')
  score(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.agents.scoreAccount(auth, id, meta);
  }

  @RequirePermission('ai.use')
  @Get('accounts/:id/scores')
  scores(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.agents.scores(auth, id);
  }

  @RequirePermission('ai.use')
  @HttpCode(200)
  @Post('scores/:id/review')
  review(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(scoreReviewSchema)) body: z.infer<typeof scoreReviewSchema>, @Meta() meta: RequestMeta) {
    return this.agents.reviewScore(auth, id, body, meta);
  }

  // ---- Visit brief & meeting intelligence
  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('visits/:id/brief')
  brief(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.agents.visitBrief(auth, id);
  }

  @RequirePermission('ai.use')
  @Get('visits/:id/brief')
  latestBrief(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.agents.latestBrief(auth, id).then((b) => b ?? {});
  }

  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('visits/:id/insights')
  insights(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.agents.meetingInsights(auth, id);
  }

  @RequirePermission('ai.use')
  @Get('visits/:id/insights')
  latestInsights(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.agents.latestInsights(auth, id).then((b) => b ?? {});
  }

  // ---- Follow-up drafts
  @RequirePermission('ai.use')
  @HttpCode(201)
  @Post('accounts/:id/follow-up')
  followUp(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(followUpBody)) body: z.infer<typeof followUpBody>) {
    return this.messaging.draftFollowUp(auth, id, body);
  }

  @RequirePermission('ai.use')
  @Get('accounts/:id/drafts')
  drafts(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.messaging.list(auth, id);
  }

  @RequirePermission('ai.use')
  @Patch('drafts/:id')
  updateDraft(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(draftUpdateSchema)) body: z.infer<typeof draftUpdateSchema>) {
    return this.messaging.update(auth, id, body);
  }

  @RequirePermission('ai.use')
  @HttpCode(200)
  @Post('drafts/:id/submit')
  submitDraft(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.messaging.submit(auth, id, meta);
  }
}

@Controller('brain')
export class BrainController {
  constructor(private readonly brain: BrainService) {}

  @RequirePermission('brain.read')
  @Get()
  overview(@Auth() auth: TenantAuthContext) {
    return this.brain.overview(auth);
  }

  @RequirePermission('brain.manage')
  @Post('items')
  create(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(brainItemSchema)) body: z.infer<typeof brainItemSchema>, @Meta() meta: RequestMeta) {
    return this.brain.create(auth, body, meta);
  }

  @RequirePermission('brain.manage')
  @Patch('items/:id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(brainItemUpdateSchema)) body: z.infer<typeof brainItemUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.brain.update(auth, id, body, meta);
  }

  @RequirePermission('brain.manage')
  @HttpCode(200)
  @Post('items/:id/approve')
  approve(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.brain.setStatus(auth, id, 'approved', meta);
  }

  @RequirePermission('brain.manage')
  @HttpCode(200)
  @Post('items/:id/archive')
  archive(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.brain.setStatus(auth, id, 'archived', meta);
  }

  @RequirePermission('brain.read')
  @Get('items/:id/versions')
  versions(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.brain.versions(auth, id);
  }

  @RequirePermission('brain.manage')
  @Post('documents')
  addDocument(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(brainDocumentSchema)) body: z.infer<typeof brainDocumentSchema>, @Meta() meta: RequestMeta) {
    return this.brain.addDocument(auth, body, meta);
  }

  @RequirePermission('brain.manage')
  @HttpCode(200)
  @Post('documents/:id/approve')
  approveDocument(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.brain.approveDocument(auth, id, meta);
  }

  @RequirePermission('brain.manage')
  @HttpCode(204)
  @Delete('documents/:id')
  async deleteDocument(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    await this.brain.deleteDocument(auth, id, meta);
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly gateway: ToolGatewayService) {}

  @RequirePermission('approvals.decide')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(approvalsQuery)) q: z.infer<typeof approvalsQuery>) {
    return this.gateway.list(auth, q.status);
  }

  @RequirePermission('approvals.decide')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.gateway.get(auth, id);
  }

  @RequirePermission('approvals.decide')
  @HttpCode(200)
  @Post(':id/decision')
  decide(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(decisionSchema)) body: z.infer<typeof decisionSchema>, @Meta() meta: RequestMeta) {
    return this.gateway.decide(auth, id, body.decision, body.note, meta);
  }
}

/** "Ask Rakan": conversations are private to their author. */
@Controller('ai/assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @RequirePermission('ai.use')
  @HttpCode(200)
  @Post('messages')
  ask(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(assistantMessageSchema)) body: z.infer<typeof assistantMessageSchema>, @Meta() meta: RequestMeta) {
    return this.assistant.ask(auth, body, meta);
  }

  @RequirePermission('ai.use')
  @Get('conversations')
  conversations(@Auth() auth: TenantAuthContext) {
    return this.assistant.conversations(auth);
  }

  @RequirePermission('ai.use')
  @Get('conversations/:id')
  conversation(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.assistant.conversation(auth, id);
  }
}
