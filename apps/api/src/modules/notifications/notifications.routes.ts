import { Router } from 'express';
import { z } from 'zod';
import { NOTIFICATION_KINDS } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import * as service from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, requirePermission('notification:read_self'));

const listSchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listNotifications(actorOf(req), parseQuery(listSchema, req.query)));
  }),
);

notificationsRouter.post(
  '/read',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ notificationIds: z.array(uuid).min(1).max(200) }), req.body);
    res.json({ updated: await service.markRead(actorOf(req), body.notificationIds) });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    res.json({ updated: await service.markAllRead(actorOf(req)) });
  }),
);

notificationsRouter.get(
  '/preferences',
  asyncHandler(async (req, res) => {
    res.json({ items: await service.getPreferences(actorOf(req)) });
  }),
);

notificationsRouter.put(
  '/preferences',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        kind: z.enum(NOTIFICATION_KINDS),
        inApp: z.boolean(),
        email: z.boolean(),
      }),
      req.body,
    );
    await service.setPreference(actorOf(req), body.kind, body.inApp, body.email);
    res.status(204).send();
  }),
);
