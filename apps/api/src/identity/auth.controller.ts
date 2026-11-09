import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, switchTenantSchema,
  type MeResponse,
} from '@rakan/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthContext, RequestMeta } from '../common/auth-context';
import { CSRF_COOKIE } from '../common/cookies';
import { Auth, AuthRateLimited, Meta, Public, TenantIsolationExempt, type RakanRequest } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
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
  ): Promise<{ ok: true }> {
    const { token } = await this.auth.login(body, meta);
    this.sessions.setCookie(res, token);
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
