import { Router } from 'express';
import { z } from 'zod';
import { isoWeekKey } from '@teamspace/shared';
import { asyncHandler, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import * as service from './dashboard.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

const weekKey = z
  .string()
  .regex(/^\d{4}-W\d{2}$/)
  .default(() => isoWeekKey(new Date()));

dashboardRouter.get(
  '/manager',
  requirePermission('capacity:read_team'),
  asyncHandler(async (req, res) => {
    const { teamId, week } = parseQuery(z.object({ teamId: uuid, week: weekKey }), req.query);
    res.json(await service.managerDashboard(actorOf(req), teamId, week));
  }),
);

dashboardRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const { week } = parseQuery(z.object({ week: weekKey }), req.query);
    res.json(await service.memberDashboard(actorOf(req), actorOf(req).id, week));
  }),
);

dashboardRouter.get(
  '/users/:userId',
  requirePermission('capacity:read_team'),
  asyncHandler(async (req, res) => {
    const { week } = parseQuery(z.object({ week: weekKey }), req.query);
    res.json(
      await service.memberDashboard(actorOf(req), z.string().uuid().parse(req.params.userId), week),
    );
  }),
);

dashboardRouter.get(
  '/me/upcoming',
  asyncHandler(async (req, res) => {
    const { days } = parseQuery(z.object({ days: z.coerce.number().int().min(1).max(60).default(7) }), req.query);
    res.json({ items: await service.myUpcoming(actorOf(req), days) });
  }),
);
