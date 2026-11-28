import { CanActivate, ExecutionContext, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { CSRF_COOKIE, CSRF_HEADER } from './cookies';
import { IS_PUBLIC, SIGNED_WEBHOOK } from './decorators';
import { generateToken, safeEqual } from './crypto';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Issues the double-submit CSRF cookie (readable by the web app, not HttpOnly). */
@Injectable()
export class CsrfCookieMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  use(req: Request, res: Response, next: NextFunction): void {
    if (!req.cookies?.[CSRF_COOKIE]) {
      const token = generateToken();
      req.cookies = { ...(req.cookies ?? {}), [CSRF_COOKIE]: token };
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false,
        sameSite: 'lax',
        secure: this.config.COOKIE_SECURE,
        path: '/',
      });
    }
    next();
  }
}

/** Every state-changing request must echo the CSRF cookie in a header. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    // Signed provider notifications carry no cookies; they must be public and check their own signature.
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SIGNED_WEBHOOK, targets) && this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = req.get(CSRF_HEADER);
    if (!cookie || !header || !safeEqual(cookie, header)) {
      throw new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
    }
    return true;
  }
}
