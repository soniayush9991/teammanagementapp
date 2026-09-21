import { Router } from 'express';
import { z } from 'zod';
import { isoWeekKey } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as service from './assignments.service.js';

export const assignmentsRouter = Router();
assignmentsRouter.use(authenticate);

const weekKey = z
  .string()
  .regex(/^\d{4}-W\d{2}$/)
  .default(() => isoWeekKey(new Date()));
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

assignmentsRouter.put(
  '/tasks/:taskIdOrKey/assignees',
  requirePermission('task:update'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        userIds: z.array(uuid).max(20),
        allocations: z.record(uuid, z.number().min(0).max(9999)).optional(),
      }),
      req.body,
    );
    res.json(
      await service.setAssignees(actorOf(req), String(req.params.taskIdOrKey), body.userIds, body.allocations),
    );
  }),
);

assignmentsRouter.post(
  '/move',
  requirePermission('task:assign'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ taskId: z.string().min(1), fromUserId: uuid, toUserId: uuid }),
      req.body,
    );
    res.json(await service.moveAssignment(actorOf(req), body.taskId, body.fromUserId, body.toUserId));
  }),
);

assignmentsRouter.post(
  '/bulk',
  requirePermission('task:bulk_assign'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ taskIds: z.array(z.string().min(1)).min(1).max(200), userIds: z.array(uuid).max(20) }),
      req.body,
    );
    res.json(await service.bulkAssign(actorOf(req), body.taskIds, body.userIds));
  }),
);

assignmentsRouter.get(
  '/compare',
  requirePermission('capacity:read_team'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        teamId: uuid,
        week: weekKey,
        estimatedHours: z.coerce.number().min(0).max(9999).default(0),
      }),
      req.query,
    );
    res.json(await service.compareWorkloads(actorOf(req), filter.teamId, filter.week, filter.estimatedHours));
  }),
);

assignmentsRouter.get(
  '/recommend',
  requirePermission('task:assign'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        taskId: z.string().min(1).optional(),
        teamId: uuid.optional(),
        skills: z
          .string()
          .optional()
          .transform((value) => (value ? value.split(',').map((skill) => skill.trim()).filter(Boolean) : undefined)),
        estimatedHours: z.coerce.number().min(0).max(9999).optional(),
        week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
        limit: z.coerce.number().int().min(1).max(20).default(5),
      }),
      req.query,
    );
    res.json(
      await service.recommendForTask(actorOf(req), {
        taskIdOrKey: filter.taskId,
        teamId: filter.teamId,
        requiredSkills: filter.skills,
        estimatedHours: filter.estimatedHours,
        weekKey: filter.week,
        limit: filter.limit,
      }),
    );
  }),
);

assignmentsRouter.get(
  '/history',
  requirePermission('report:read_team'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        teamId: uuid.optional(),
        userId: uuid.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    res.json({ items: await service.assignmentHistory(actorOf(req), filter) });
  }),
);

assignmentsRouter.patch(
  '/tasks/:taskIdOrKey/allocation',
  requirePermission('task:update'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ userId: uuid, allocatedHours: z.number().min(0).max(9999) }), req.body);
    res.json(
      await service.updateAllocation(
        actorOf(req),
        String(req.params.taskIdOrKey),
        body.userId,
        body.allocatedHours,
      ),
    );
  }),
);
