import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './env.js';
import { query } from './db/pool.js';
import { asyncHandler } from './lib/http.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestId } from './middleware/requestId.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { assignmentsRouter } from './modules/assignments/assignments.routes.js';
import { attachmentsRouter } from './modules/attachments/attachments.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { capacityRouter } from './modules/capacity/capacity.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { teamsRouter } from './modules/teams/teams.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/**
 * Locates the built web bundle. Present in a deployment (the API serves the
 * SPA from the same origin); absent in local development, where Vite serves
 * it on :5173 and proxies back here.
 *
 * `src/` and `dist/` sit at the same depth under apps/api, so one relative
 * path covers running from source and from the compiled output.
 */
function resolveWebDist(): string | null {
  const configured = env().WEB_DIST_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = configured ? resolve(configured) : resolve(here, '..', '..', 'web', 'dist');
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

export function createApp(): Express {
  const app = express();
  const webDist = resolveWebDist();

  // Behind a load balancer, req.ip must come from X-Forwarded-For or every
  // rate limit bucket collapses onto the proxy's address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        // Serving only JSON allows the strictest possible policy. Serving the
        // SPA means allowing its own assets — but nothing third-party.
        directives: webDist
          ? {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              // React renders style={{…}} props as inline style attributes.
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              // Same-origin XHR plus the WebSocket on the same host.
              connectSrc: ["'self'", 'ws:', 'wss:'],
              fontSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              frameAncestors: ["'none'"],
            }
          : { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(
    cors({
      origin: env().WEB_ORIGIN.split(',').map((origin) => origin.trim()),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      maxAge: 600,
    }),
  );
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Liveness: process is up. Readiness: the database answers.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });
  app.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      await query('SELECT 1');
      res.json({ status: 'ready' });
    }),
  );

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/teams', teamsRouter);
  api.use('/tasks', tasksRouter);
  api.use('/capacity', capacityRouter);
  api.use('/assignments', assignmentsRouter);
  api.use('/conversations', conversationsRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/search', searchRouter);
  api.use('/reports', reportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/admin', adminRouter);

  // The authenticated identity of the caller, handy for debugging clients.
  api.get(
    '/whoami',
    authenticate,
    asyncHandler(async (req, res) => {
      res.json({ actor: req.actor });
    }),
  );

  app.use('/api/v1', api);

  if (webDist) {
    // Asset filenames are content-hashed so they can be cached indefinitely,
    // but index.html must not be, or a deploy leaves browsers pinned to the
    // previous bundle.
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (response, filePath) => {
          response.setHeader(
            'cache-control',
            filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
          );
        },
      }),
    );

    // Client-side routes (/board, /tasks/PLAT-1, …) are not files on disk, so
    // anything that is not an API or health path serves the SPA shell and lets
    // the router take over. Unknown /api paths still fall through to the JSON
    // 404 below rather than being handed an HTML page.
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/') || request.path === '/healthz' || request.path === '/readyz') {
        next();
        return;
      }
      // sendFile bypasses express.static's setHeaders, so the shell needs the
      // same no-cache treatment applied here.
      response.setHeader('cache-control', 'no-cache');
      response.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
