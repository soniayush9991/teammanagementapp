import { Router } from 'express';
import { z } from 'zod';
import { CONVERSATION_KINDS, CONVERSATION_VISIBILITIES } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as conversations from './conversations.service.js';
import * as messages from '../messages/messages.service.js';

export const conversationsRouter = Router();
conversationsRouter.use(authenticate, requirePermission('conversation:read'));

conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        kind: z.enum(CONVERSATION_KINDS).optional(),
        includePublic: z.coerce.boolean().default(false),
        search: z.string().trim().min(1).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    res.json({ items: await conversations.listConversations(actorOf(req), filter) });
  }),
);

const createGroupSchema = z.object({
  kind: z.enum(['group', 'channel']),
  name: z.string().trim().min(1).max(120),
  topic: z.string().trim().max(500).optional(),
  visibility: z.enum(CONVERSATION_VISIBILITIES).default('private'),
  teamId: uuid.nullish(),
  memberIds: z.array(uuid).max(500).optional(),
});

conversationsRouter.post(
  '/',
  requirePermission('conversation:create_group'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await conversations.createGroup(actorOf(req), parseBody(createGroupSchema, req.body)));
  }),
);

conversationsRouter.post(
  '/direct',
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ userId: uuid }), req.body);
    res.status(201).json(await conversations.openDirectMessage(actorOf(req), body.userId));
  }),
);

conversationsRouter.get(
  '/:conversationId',
  asyncHandler(async (req, res) => {
    res.json(await conversations.getConversation(actorOf(req), z.string().uuid().parse(req.params.conversationId)));
  }),
);

conversationsRouter.patch(
  '/:conversationId',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        topic: z.string().trim().max(500).nullish(),
        visibility: z.enum(CONVERSATION_VISIBILITIES).optional(),
      }),
      req.body,
    );
    res.json(
      await conversations.updateConversation(
        actorOf(req),
        z.string().uuid().parse(req.params.conversationId),
        body,
      ),
    );
  }),
);

conversationsRouter.get(
  '/:conversationId/members',
  asyncHandler(async (req, res) => {
    res.json({
      items: await conversations.listMembers(actorOf(req), z.string().uuid().parse(req.params.conversationId)),
    });
  }),
);

conversationsRouter.post(
  '/:conversationId/members',
  requirePermission('conversation:manage_members'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ userIds: z.array(uuid).min(1).max(200) }), req.body);
    res.json({
      items: await conversations.inviteMembers(
        actorOf(req),
        z.string().uuid().parse(req.params.conversationId),
        body.userIds,
      ),
    });
  }),
);

conversationsRouter.delete(
  '/:conversationId/members/:userId',
  requirePermission('conversation:manage_members'),
  asyncHandler(async (req, res) => {
    await conversations.removeMember(
      actorOf(req),
      z.string().uuid().parse(req.params.conversationId),
      z.string().uuid().parse(req.params.userId),
    );
    res.status(204).send();
  }),
);

conversationsRouter.put(
  '/:conversationId/members/:userId/role',
  requirePermission('conversation:manage_members'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ role: z.enum(['owner', 'admin', 'member']) }), req.body);
    await conversations.setMemberRole(
      actorOf(req),
      z.string().uuid().parse(req.params.conversationId),
      z.string().uuid().parse(req.params.userId),
      body.role,
    );
    res.status(204).send();
  }),
);

conversationsRouter.post(
  '/:conversationId/join',
  asyncHandler(async (req, res) => {
    res.json(await conversations.joinConversation(actorOf(req), z.string().uuid().parse(req.params.conversationId)));
  }),
);

conversationsRouter.post(
  '/:conversationId/leave',
  asyncHandler(async (req, res) => {
    await conversations.leaveConversation(actorOf(req), z.string().uuid().parse(req.params.conversationId));
    res.status(204).send();
  }),
);

conversationsRouter.put(
  '/:conversationId/notification-level',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ level: z.enum(['all', 'mentions', 'none']) }), req.body);
    await conversations.setNotificationLevel(
      actorOf(req),
      z.string().uuid().parse(req.params.conversationId),
      body.level,
    );
    res.status(204).send();
  }),
);

conversationsRouter.get(
  '/:conversationId/tasks',
  asyncHandler(async (req, res) => {
    res.json({
      items: await conversations.listLinkedTasks(actorOf(req), z.string().uuid().parse(req.params.conversationId)),
    });
  }),
);

conversationsRouter.post(
  '/:conversationId/tasks',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ taskId: uuid }), req.body);
    await conversations.linkTask(actorOf(req), z.string().uuid().parse(req.params.conversationId), body.taskId);
    res.status(201).json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Messages live under their conversation so every route is scope-checked by
// the conversation the caller names, never by the message id alone.
// ---------------------------------------------------------------------------

conversationsRouter.get(
  '/:conversationId/messages',
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        parentMessageId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
      req.query,
    );
    res.json(
      await messages.listMessages(actorOf(req), z.string().uuid().parse(req.params.conversationId), filter),
    );
  }),
);

conversationsRouter.post(
  '/:conversationId/messages',
  requirePermission('message:send'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        body: z.string().min(1).max(10_000),
        parentMessageId: uuid.nullish(),
        attachmentIds: z.array(uuid).max(10).optional(),
      }),
      req.body,
    );
    res.status(201).json(
      await messages.sendMessage(actorOf(req), z.string().uuid().parse(req.params.conversationId), body),
    );
  }),
);

conversationsRouter.patch(
  '/:conversationId/messages/:messageId',
  requirePermission('message:edit_own'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ body: z.string().min(1).max(10_000) }), req.body);
    res.json(
      await messages.editMessage(
        actorOf(req),
        z.string().uuid().parse(req.params.conversationId),
        z.string().uuid().parse(req.params.messageId),
        body.body,
      ),
    );
  }),
);

conversationsRouter.delete(
  '/:conversationId/messages/:messageId',
  requirePermission('message:delete_own'),
  asyncHandler(async (req, res) => {
    await messages.deleteMessage(
      actorOf(req),
      z.string().uuid().parse(req.params.conversationId),
      z.string().uuid().parse(req.params.messageId),
    );
    res.status(204).send();
  }),
);

conversationsRouter.post(
  '/:conversationId/messages/:messageId/reactions',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ emoji: z.string().min(1).max(32) }), req.body);
    res.json(
      await messages.toggleReaction(
        actorOf(req),
        z.string().uuid().parse(req.params.conversationId),
        z.string().uuid().parse(req.params.messageId),
        body.emoji,
      ),
    );
  }),
);

conversationsRouter.post(
  '/:conversationId/messages/:messageId/pin',
  requirePermission('conversation:pin_message'),
  asyncHandler(async (req, res) => {
    res.json(
      await messages.togglePin(
        actorOf(req),
        z.string().uuid().parse(req.params.conversationId),
        z.string().uuid().parse(req.params.messageId),
      ),
    );
  }),
);

conversationsRouter.get(
  '/:conversationId/pinned',
  asyncHandler(async (req, res) => {
    res.json({ items: await messages.listPinned(actorOf(req), z.string().uuid().parse(req.params.conversationId)) });
  }),
);

conversationsRouter.post(
  '/:conversationId/read',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ messageId: uuid.optional() }), req.body ?? {});
    res.json(
      await messages.markRead(actorOf(req), z.string().uuid().parse(req.params.conversationId), body.messageId),
    );
  }),
);

conversationsRouter.get(
  '/:conversationId/attachments',
  asyncHandler(async (req, res) => {
    res.json({
      items: await messages.listAttachments(actorOf(req), z.string().uuid().parse(req.params.conversationId)),
    });
  }),
);
