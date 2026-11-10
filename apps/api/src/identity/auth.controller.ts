import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  forgotPasswordSchema, loginSchema, mfaLoginSchema, registerSchema, resetPasswordSchema, switchTenantSchema, totpCodeSchema, verifyEmailSchema,
  type MeResponse,
} from '@rakan/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthContext, RequestMeta } from '../common/auth-context';
import { CSRF_COOKIE } from '../common/cookies';
import { Auth, AuthRateLimited, Meta, Public, TenantIsolationExempt, type RakanRequest } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { SecurityService } from './security.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly securitySvc: SecurityService,
  ) {}

  /** Returns the CSRF token (the cookie is set by middleware on any request). */
  @Public()
  @Get('csrf')
  csrf(@Req() req: RakanRequest): { csrfToken: string } {
    return { csrfToken: req.cookies?.[CSRF_COOKIE] as string };
  }

  @Public()
  @AuthRateLimited()
  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { token } = await this.auth.register(body, meta);
    this.sessions.setCookie(res, token);
    return { ok: true };
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true } | { mfaRequired: true; challenge: string }> {
    const result = await this.auth.login(body, meta);
    if ('mfaChallenge' in result) return { mfaRequired: true, challenge: result.mfaChallenge };
    this.sessions.setCookie(res, result.token);
    return { ok: true };
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(200)
  @Post('mfa/verify')
  async mfaVerify(
    @Body(new ZodPipe(mfaLoginSchema)) body: z.infer<typeof mfaLoginSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { token } = await this.auth.completeMfa(body.challenge, body.code, meta);
    this.sessions.setCookie(res, token);
    return { ok: true };
  }

  @TenantIsolationExempt('acts on the caller own account only')
  @Get('security')
  security(@Auth() auth: AuthContext) {
    return this.securitySvc.overview(auth);
  }

  @TenantIsolationExempt('acts on the caller own account only')
  @HttpCode(200)
  @Post('mfa/setup')
  mfaSetup(@Auth() auth: AuthContext) {
    return this.securitySvc.setup(auth);
  }

  @TenantIsolationExempt('acts on the caller own account only')
  @HttpCode(200)
  @Post('mfa/enable')
  mfaEnable(@Auth() auth: AuthContext, @Body(new ZodPipe(totpCodeSchema)) body: { code: string }, @Meta() meta: RequestMeta) {
    return this.securitySvc.enable(auth, body.code, meta);
  }

  @TenantIsolationExempt('acts on the caller own account only')
  @HttpCode(204)
  @Post('mfa/disable')
  async mfaDisable(@Auth() auth: AuthContext, @Body(new ZodPipe(totpCodeSchema)) body: { code: string }, @Meta() meta: RequestMeta) {
    await this.securitySvc.disable(auth, body.code, meta);
  }

  @TenantIsolationExempt('scoped to the caller own sessions; other ids are not found')
  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(@Auth() auth: AuthContext, @Param('id', UuidPipe) id: string, @Meta() meta: RequestMeta) {
    await this.securitySvc.revokeSession(auth, id, meta);
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(200)
  @Post('email/verify')
  async verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: { token: string }, @Meta() meta: RequestMeta): Promise<{ ok: true }> {
    await this.securitySvc.verifyEmail(body.token, meta);
    return { ok: true };
  }

  @TenantIsolationExempt('acts on the caller own account only')
  @AuthRateLimited()
  @HttpCode(202)
  @Post('email/resend')
  async resendVerification(@Auth() auth: AuthContext): Promise<{ ok: true }> {
    await this.securitySvc.sendVerification(auth.userId);
    return { ok: true };
  }

  @TenantIsolationExempt('acts on the caller own session only')
  @HttpCode(204)
  @Post('logout')
  async logout(@Auth() auth: AuthContext, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth, meta);
    this.sessions.clearCookie(res);
  }

  @TenantIsolationExempt('returns the caller own profile and memberships')
  @Get('me')
  me(@Auth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @TenantIsolationExempt('membership of the caller is verified inside the service; non-members get 404')
  @HttpCode(200)
  @Post('switch-tenant')
  async switchTenant(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(switchTenantSchema)) body: z.infer<typeof switchTenantSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = await this.auth.switchTenant(auth, body.tenantId, meta);
    this.sessions.setCookie(res, token);
    return { ok: true };
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(202)
  @Post('password/forgot')
  async forgot(
    @Body(new ZodPipe(forgotPasswordSchema.extend({ locale: z.enum(['ar', 'en']).default('ar') })))
    body: { email: string; locale: 'ar' | 'en' },
    @Meta() meta: RequestMeta,
  ): Promise<{ ok: true }> {
    await this.auth.forgotPassword(body.email, body.locale, meta);
    return { ok: true };
  }

  @Public()
  @AuthRateLimited()
  @HttpCode(200)
  @Post('password/reset')
  async reset(
    @Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.auth.resetPassword(body.token, body.password, meta);
    this.sessions.clearCookie(res);
    return { ok: true };
  }
}
