import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as service from './users.service.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  teamId: uuid.optional(),
  managerId: uuid.optional(),
  includeInactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

usersRouter.get(
  '/',
  requirePermission('user:read'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(listQuerySchema, req.query);
    res.json({ items: await service.listUsers(actorOf(req), filter) });
  }),
);

usersRouter.get(
  '/skills',
  requirePermission('user:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listSkills(actorOf(req)) });
  }),
);

usersRouter.get(
  '/:userId',
  requirePermission('user:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.getUser(actorOf(req), z.string().uuid().parse(req.params.userId)));
  }),
);

usersRouter.get(
  '/:userId/reportees',
  requirePermission('user:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listReportees(actorOf(req), z.string().uuid().parse(req.params.userId)) });
  }),
);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(200),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(ROLES).default('member'),
  jobTitle: z.string().trim().max(120).optional(),
  timezone: z.string().max(64).optional(),
  weeklyCapacityHours: z.number().min(0).max(168).optional(),
  managerId: uuid.nullish(),
  skills: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
});

usersRouter.post(
  '/',
  requirePermission('user:create'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    res.status(201).json(
      await service.createUser(actorOf(req), { ...body, managerId: body.managerId ?? null }),
    );
  }),
);

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().nullish(),
  jobTitle: z.string().trim().max(120).nullish(),
  timezone: z.string().max(64).optional(),
  weeklyCapacityHours: z.number().min(0).max(168).optional(),
  managerId: uuid.nullish(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
});

usersRouter.patch(
  '/:userId',
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    res.json(await service.updateUser(actorOf(req), z.string().uuid().parse(req.params.userId), body));
  }),
);

usersRouter.delete(
  '/:userId',
  requirePermission('user:deactivate'),
  asyncHandler(async (req, res) => {
    await service.deactivateUser(actorOf(req), z.string().uuid().parse(req.params.userId));
    res.status(204).send();
  }),
);
