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

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, req.ip must come from X-Forwarded-For or every
  // rate limit bucket collapses onto the proxy's address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and presigned redirects only; a strict CSP here
      // costs nothing and blocks content sniffing surprises.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
