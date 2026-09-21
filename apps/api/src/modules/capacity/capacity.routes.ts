import { Router } from 'express';
import { z } from 'zod';
import { isoWeekKey, LEAVE_KINDS, LEAVE_STATUSES } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as service from './capacity.service.js';

export const capacityRouter = Router();
capacityRouter.use(authenticate);

const weekKey = z
  .string()
  .regex(/^\d{4}-W\d{2}$/, 'must be an ISO week key like 2026-W39')
  .default(() => isoWeekKey(new Date()));
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

capacityRouter.get(
  '/me',
  requirePermission('capacity:read_self'),
  asyncHandler(async (req, res) => {
    const { week } = parseQuery(z.object({ week: weekKey }), req.query);
    res.json(await service.getUserCapacity(actorOf(req), actorOf(req).id, week));
  }),
);

capacityRouter.get(
  '/users/:userId',
  requirePermission('capacity:read_self'),
  asyncHandler(async (req, res) => {
    const { week } = parseQuery(z.object({ week: weekKey }), req.query);
    res.json(await service.getUserCapacity(actorOf(req), z.string().uuid().parse(req.params.userId), week));
  }),
);

capacityRouter.get(
  '/teams/:teamId',
  requirePermission('capacity:read_team'),
  asyncHandler(async (req, res) => {
    const { week } = parseQuery(z.object({ week: weekKey }), req.query);
    res.json(await service.getTeamCapacity(actorOf(req), z.string().uuid().parse(req.params.teamId), week));
  }),
);

capacityRouter.get(
  '/teams/:teamId/horizon',
  requirePermission('capacity:read_team'),
  asyncHandler(async (req, res) => {
    const { weeks } = parseQuery(z.object({ weeks: z.coerce.number().int().min(1).max(12).default(4) }), req.query);
    res.json({
      items: await service.getCapacityHorizon(actorOf(req), z.string().uuid().parse(req.params.teamId), weeks),
    });
  }),
);

const overrideSchema = z.object({
  userId: uuid,
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
  capacityHours: z.number().min(0).max(168),
  note: z.string().max(500).optional(),
});

capacityRouter.put(
  '/overrides',
  requirePermission('capacity:update_self'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(overrideSchema, req.body);
    res.json(
      await service.setWeeklyCapacityOverride(
        actorOf(req),
        body.userId,
        body.weekKey,
        body.capacityHours,
        body.note,
      ),
    );
  }),
);

const leaveSchema = z
  .object({
    userId: uuid.optional(),
    kind: z.enum(LEAVE_KINDS).default('vacation'),
    startDate: dateString,
    endDate: dateString,
    hoursPerDay: z.number().positive().max(24).default(8),
    note: z.string().max(1000).optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate must not precede startDate',
    path: ['endDate'],
  });

capacityRouter.post(
  '/leave',
  requirePermission('leave:request'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.requestLeave(actorOf(req), parseBody(leaveSchema, req.body)));
  }),
);

capacityRouter.get(
  '/leave',
  requirePermission('leave:request'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        userId: uuid.optional(),
        teamId: uuid.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        status: z.enum(LEAVE_STATUSES).optional(),
      }),
      req.query,
    );
    res.json({ items: await service.listLeave(actorOf(req), filter) });
  }),
);

capacityRouter.post(
  '/leave/:leaveId/decision',
  requirePermission('leave:approve'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
    res.json(
      await service.decideLeave(actorOf(req), z.string().uuid().parse(req.params.leaveId), body.decision),
    );
  }),
);
