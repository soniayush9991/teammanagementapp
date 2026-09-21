import { Router } from 'express';
import { z } from 'zod';
import {
  DEPENDENCY_TYPES,
  RECURRENCE_FREQUENCIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import * as service from './tasks.service.js';

export const tasksRouter = Router();
tasksRouter.use(authenticate);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
/** Accepts a comma-separated list or a repeated query parameter. */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values), z.array(z.enum(values)), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (Array.isArray(value)) return value as z.infer<z.ZodEnum<never>>[];
      return String(value)
        .split(',')
        .map((part) => part.trim())
        .filter((part): part is T[number] => (values as readonly string[]).includes(part));
    });

const listSchema = z.object({
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
  status: csvEnum(TASK_STATUSES),
  priority: csvEnum(TASK_PRIORITIES),
  label: z.string().trim().max(60).optional(),
  dueBefore: dateString.optional(),
  dueAfter: dateString.optional(),
  parentTaskId: uuid.optional(),
  includeSubtasks: z.coerce.boolean().default(false),
  overdueOnly: z.coerce.boolean().default(false),
  search: z.string().trim().min(2).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

tasksRouter.get(
  '/',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(listSchema, req.query);
    res.json(await service.listTasks(actorOf(req), filter));
  }),
);

const boardSchema = z.object({ teamId: uuid });

tasksRouter.get(
  '/board',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    const { teamId } = parseQuery(boardSchema, req.query);
    res.json({ columns: await service.kanbanBoard(actorOf(req), teamId) });
  }),
);

const calendarSchema = z.object({
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
  from: dateString,
  to: dateString,
});

tasksRouter.get(
  '/calendar',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.calendarTasks(actorOf(req), parseQuery(calendarSchema, req.query)) });
  }),
);

const recurrenceSchema = z
  .object({
    frequency: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(52).default(1),
    until: dateString.nullish(),
  })
  .nullish();

const createSchema = z.object({
  teamId: uuid,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  parentTaskId: uuid.nullish(),
  assigneeIds: z.array(uuid).max(20).optional(),
  startDate: dateString.nullish(),
  dueDate: dateString.nullish(),
  estimatedHours: z.number().min(0).max(9999).optional(),
  labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  recurrence: recurrenceSchema,
});

tasksRouter.post(
  '/',
  requirePermission('task:create'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createTask(actorOf(req), parseBody(createSchema, req.body)));
  }),
);

tasksRouter.get(
  '/:taskIdOrKey',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.getTask(actorOf(req), String(req.params.taskIdOrKey)));
  }),
);

const updateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  startDate: dateString.nullish(),
  dueDate: dateString.nullish(),
  estimatedHours: z.number().min(0).max(9999).optional(),
  remainingHours: z.number().min(0).max(9999).optional(),
  labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

tasksRouter.patch(
  '/:taskIdOrKey',
  requirePermission('task:update'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.json(
      await service.updateTask(actorOf(req), String(req.params.taskIdOrKey), parseBody(updateSchema, req.body)),
    );
  }),
);

tasksRouter.delete(
  '/:taskIdOrKey',
  requirePermission('task:delete'),
  asyncHandler(async (req, res) => {
    await service.deleteTask(actorOf(req), String(req.params.taskIdOrKey));
    res.status(204).send();
  }),
);

tasksRouter.get(
  '/:taskIdOrKey/comments',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listComments(actorOf(req), String(req.params.taskIdOrKey)) });
  }),
);

tasksRouter.post(
  '/:taskIdOrKey/comments',
  requirePermission('task:read'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ body: z.string().trim().min(1).max(10_000) }), req.body);
    res.status(201).json(await service.addComment(actorOf(req), String(req.params.taskIdOrKey), body.body));
  }),
);

tasksRouter.get(
  '/:taskIdOrKey/activity',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listActivity(actorOf(req), String(req.params.taskIdOrKey)) });
  }),
);

tasksRouter.get(
  '/:taskIdOrKey/dependencies',
  requirePermission('task:read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listDependencies(actorOf(req), String(req.params.taskIdOrKey)) });
  }),
);

tasksRouter.post(
  '/:taskIdOrKey/dependencies',
  requirePermission('task:update'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ dependsOnTaskId: z.string().min(1), type: z.enum(DEPENDENCY_TYPES).default('blocks') }),
      req.body,
    );
    await service.addDependency(
      actorOf(req),
      String(req.params.taskIdOrKey),
      body.dependsOnTaskId,
      body.type,
    );
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.delete(
  '/:taskIdOrKey/dependencies/:dependencyId',
  requirePermission('task:update'),
  asyncHandler(async (req, res) => {
    await service.removeDependency(
      actorOf(req),
      String(req.params.taskIdOrKey),
      z.string().uuid().parse(req.params.dependencyId),
    );
    res.status(204).send();
  }),
);

const logWorkSchema = z.object({
  hours: z.number().positive().max(24),
  loggedOn: dateString.default(() => new Date().toISOString().slice(0, 10)),
  remainingHours: z.number().min(0).max(9999).optional(),
  note: z.string().max(1000).optional(),
});

tasksRouter.post(
  '/:taskIdOrKey/work-logs',
  requirePermission('task:update_progress'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(logWorkSchema, req.body);
    res.status(201).json(
      await service.logWork(
        actorOf(req),
        String(req.params.taskIdOrKey),
        body.hours,
        body.loggedOn,
        body.remainingHours,
        body.note,
      ),
    );
  }),
);
