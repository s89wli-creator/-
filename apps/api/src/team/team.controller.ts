import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
import {
  acceptInvitationSchema, inviteSchema, territoryAssignmentSchema, territorySchema, updateMemberSchema,
  type InvitationDto, type InviteInput, type MemberDto, type TerritoryDto, type TerritoryInput, type UpdateMemberInput,
} from '@rakan/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, AuthRateLimited, Meta, Public, RequirePermission } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { SessionService } from '../identity/session.service';
import { TeamService, type InvitationPreview } from './team.service';
import { TerritoryService } from './territory.service';

@Controller('team')
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly territories: TerritoryService,
  ) {}

  @RequirePermission('team.member.read')
  @Get('members')
  members(@Auth() auth: TenantAuthContext): Promise<MemberDto[]> {
    return this.team.listMembers(auth);
  }

  @RequirePermission('team.member.update')
  @Patch('members/:id')
  updateMember(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateMemberSchema)) body: UpdateMemberInput,
    @Meta() meta: RequestMeta,
  ): Promise<MemberDto> {
    return this.team.updateMember(auth, id, body, meta);
  }

  @RequirePermission('team.member.read')
  @Get('invitations')
  invitations(@Auth() auth: TenantAuthContext): Promise<InvitationDto[]> {
    return this.team.listInvitations(auth);
  }

  @RequirePermission('team.member.invite')
  @Post('invitations')
  invite(
    @Auth() auth: TenantAuthContext,
    @Body(new ZodPipe(inviteSchema)) body: InviteInput,
    @Meta() meta: RequestMeta,
  ): Promise<InvitationDto> {
    return this.team.invite(auth, body, meta);
  }

  @RequirePermission('team.member.invite')
  @HttpCode(204)
  @Delete('invitations/:id')
  revoke(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    return this.team.revokeInvitation(auth, id, meta);
  }

  @RequirePermission('team.territory.read')
  @Get('territories')
  listTerritories(@Auth() auth: TenantAuthContext): Promise<TerritoryDto[]> {
    return this.territories.list(auth);
  }

  @RequirePermission('team.territory.manage')
  @Post('territories')
  createTerritory(
    @Auth() auth: TenantAuthContext,
    @Body(new ZodPipe(territorySchema)) body: TerritoryInput,
    @Meta() meta: RequestMeta,
  ): Promise<TerritoryDto> {
    return this.territories.create(auth, body, meta);
  }

  @RequirePermission('team.territory.manage')
  @Patch('territories/:id')
  updateTerritory(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(territorySchema)) body: TerritoryInput,
    @Meta() meta: RequestMeta,
  ): Promise<TerritoryDto> {
    return this.territories.update(auth, id, body, meta);
  }

  @RequirePermission('team.territory.manage')
  @HttpCode(204)
  @Delete('territories/:id')
  deleteTerritory(@Auth() auth: TenantAuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    return this.territories.remove(auth, id, meta);
  }

  @RequirePermission('team.territory.manage')
  @Put('territories/:id/members')
  setTerritoryMembers(
    @Auth() auth: TenantAuthContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(territoryAssignmentSchema)) body: z.infer<typeof territoryAssignmentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TerritoryDto> {
    return this.territories.setMembers(auth, id, body.membershipIds, meta);
  }
}

/** Public invitation endpoints (token-based; the token is the credential). */
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly team: TeamService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @AuthRateLimited()
  @Get(':token')
  preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.team.previewInvitation(token);
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(200)
  @Post('accept')
  async accept(
    @Body(new ZodPipe(acceptInvitationSchema)) body: z.infer<typeof acceptInvitationSchema>,
    @Auth() auth: AuthContext | undefined,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true; tenantId: string }> {
    const result = await this.team.acceptInvitation(body, auth, meta);
    const token = auth
      ? await this.sessions.switchTenant(auth.sessionId, result.tenantId)
      : await this.sessions.create(result.userId, result.tenantId, meta);
    this.sessions.setCookie(res, token);
    return { ok: true, tenantId: result.tenantId };
  }
}
