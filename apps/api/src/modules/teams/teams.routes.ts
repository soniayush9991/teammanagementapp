import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as service from './teams.service.js';

export const teamsRouter = Router();
teamsRouter.use(authenticate);

teamsRouter.get(
  '/',
  requirePermission('team:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listTeams(actorOf(req)) });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  // Becomes the task key prefix, e.g. PLAT -> PLAT-1.
  keyPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'must be 2-10 letters/digits starting with a letter'),
  managerId: uuid.optional(),
  memberIds: z.array(uuid).max(200).optional(),
});

teamsRouter.post(
  '/',
  requirePermission('team:create'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createTeam(actorOf(req), parseBody(createSchema, req.body)));
  }),
);

teamsRouter.get(
  '/:teamId',
  requirePermission('team:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.getTeam(actorOf(req), z.string().uuid().parse(req.params.teamId)));
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullish(),
  managerId: uuid.optional(),
});

teamsRouter.patch(
  '/:teamId',
  requirePermission('team:update'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.json(
      await service.updateTeam(actorOf(req), z.string().uuid().parse(req.params.teamId), parseBody(updateSchema, req.body)),
    );
  }),
);

teamsRouter.delete(
  '/:teamId',
  requirePermission('team:delete'),
  asyncHandler(async (req, res) => {
    await service.archiveTeam(actorOf(req), z.string().uuid().parse(req.params.teamId));
    res.status(204).send();
  }),
);

teamsRouter.get(
  '/:teamId/members',
  requirePermission('team:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listMembers(actorOf(req), z.string().uuid().parse(req.params.teamId)) });
  }),
);

const addMembersSchema = z.object({
  userIds: z.array(uuid).min(1).max(200),
  roleInTeam: z.enum(['lead', 'member']).default('member'),
});

teamsRouter.post(
  '/:teamId/members',
  requirePermission('team:manage_members'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(addMembersSchema, req.body);
    res.json({
      items: await service.addMembers(
        actorOf(req),
        z.string().uuid().parse(req.params.teamId),
        body.userIds,
        body.roleInTeam,
      ),
    });
  }),
);

teamsRouter.delete(
  '/:teamId/members/:userId',
  requirePermission('team:manage_members'),
  asyncHandler(async (req, res) => {
    await service.removeMember(
      actorOf(req),
      z.string().uuid().parse(req.params.teamId),
      z.string().uuid().parse(req.params.userId),
    );
    res.status(204).send();
  }),
);
