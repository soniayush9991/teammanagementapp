import { Router, type Response } from 'express';
import { z } from 'zod';
import { env, isProduction } from '../../env.js';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { actorOf, authenticate } from '../../middleware/auth.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import * as service from './auth.service.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'teamspace_rt';

/**
 * The refresh token lives in an httpOnly, SameSite=Strict cookie so client
 * JavaScript (and therefore any XSS) cannot read it. The short-lived access
 * token is returned in the body and kept in memory by the SPA.
 */
function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

authRouter.post(
  '/login',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const issued = await service.login(email, password, service.contextOf(req));
    setRefreshCookie(res, issued.refreshToken, issued.refreshTokenExpiresAt);
    res.json(issued.session);
  }),
);

authRouter.post(
  '/refresh',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const token = cookies?.[REFRESH_COOKIE] ?? bodyToken;
    if (!token) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'No refresh token supplied' } });
      return;
    }
    const issued = await service.refresh(token, service.contextOf(req));
    // A grace-window response did not rotate anything, so the client's
    // existing cookie is newer than what we hold here — do not overwrite it.
    if (issued.rotated) setRefreshCookie(res, issued.refreshToken, issued.refreshTokenExpiresAt);
    res.json(issued.session);
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    await service.logout(cookies?.[REFRESH_COOKIE], null);
    clearRefreshCookie(res);
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await service.currentSession(actorOf(req).id));
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(200),
});

authRouter.post(
  '/change-password',
  authenticate,
  authRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(changePasswordSchema, req.body);
    await service.changePassword(
      actorOf(req).id,
      body.currentPassword,
      body.newPassword,
      service.contextOf(req),
    );
    clearRefreshCookie(res);
    res.status(204).send();
  }),
);

/** Exposed so the WebSocket handshake can reuse the same TTL. */
export const accessTokenTtlSeconds = () => env().ACCESS_TOKEN_TTL;
