import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  proposalCreateSchema, proposalDecisionSchema, proposalDraftAiSchema, proposalListQuerySchema, proposalUpdateSchema,
} from '@rakan/shared';
import { z } from 'zod';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, AuthRateLimited, Meta, Public, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { ProposalsService } from './proposals.service';

@Controller('crm/proposals')
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @RequirePermission('crm.proposal.read')
  @Get()
  list(@Auth() auth: TenantAuthContext, @Query(new ZodPipe(proposalListQuerySchema)) q: z.infer<typeof proposalListQuerySchema>) {
    return this.proposals.list(auth, q);
  }

  @RequirePermission('crm.proposal.read')
  @Get('price-list')
  priceList(@Auth() auth: TenantAuthContext) {
    return this.proposals.priceListDto(auth);
  }

  @RequirePermission('crm.proposal.read')
  @Get(':id')
  get(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string) {
    return this.proposals.get(auth, id);
  }

  @RequirePermission('crm.proposal.write')
  @Post()
  create(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(proposalCreateSchema)) body: z.infer<typeof proposalCreateSchema>, @Meta() meta: RequestMeta) {
    return this.proposals.create(auth, body, meta);
  }

  /** The proposal agent drafts from the approved price list (needs ai.use too). */
  @RequirePermission('crm.proposal.write')
  @Post('ai-draft')
  aiDraft(@Auth() auth: TenantAuthContext, @Body(new ZodPipe(proposalDraftAiSchema)) body: z.infer<typeof proposalDraftAiSchema>, @Meta() meta: RequestMeta) {
    return this.proposals.draftWithAi(auth, body, meta);
  }

  @RequirePermission('crm.proposal.write')
  @Patch(':id')
  update(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(proposalUpdateSchema)) body: z.infer<typeof proposalUpdateSchema>, @Meta() meta: RequestMeta) {
    return this.proposals.update(auth, id, body, meta);
  }

  @RequirePermission('crm.proposal.write')
  @HttpCode(200)
  @Post(':id/submit')
  submit(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.proposals.submit(auth, id, meta);
  }

  @RequirePermission('crm.proposal.write')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.proposals.cancel(auth, id, meta);
  }

  @RequirePermission('crm.proposal.write')
  @HttpCode(200)
  @Post(':id/revise')
  revise(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    return this.proposals.revise(auth, id, meta);
  }
}

/** The customer's private link: no account, the unguessable token is the only key. */
@Public()
@Controller('public/proposals')
export class PublicProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get(':token')
  view(@Param('token') token: string) {
    return this.proposals.publicView(token);
  }

  @AuthRateLimited()
  @HttpCode(200)
  @Post(':token/decision')
  decide(@Param('token') token: string, @Body(new ZodPipe(proposalDecisionSchema)) body: z.infer<typeof proposalDecisionSchema>, @Meta() meta: RequestMeta) {
    return this.proposals.publicDecide(token, body, meta);
  }
}
