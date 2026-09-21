import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate } from '../../middleware/auth.js';
import { searchRateLimit } from '../../middleware/rateLimit.js';
import * as service from './search.service.js';

export const searchRouter = Router();
searchRouter.use(authenticate, searchRateLimit);

const typeEnum = z.enum(['task', 'message', 'attachment']);

const searchSchema = z.object({
  q: z.string().trim().min(2, 'search for at least two characters').max(200),
  types: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return ['task', 'message', 'attachment'] as const;
      const parsed = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => typeEnum.safeParse(part).success) as ('task' | 'message' | 'attachment')[];
      return parsed.length > 0 ? parsed : (['task', 'message', 'attachment'] as const);
    }),
  conversationId: uuid.optional(),
  authorId: uuid.optional(),
  teamId: uuid.optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = parseQuery(searchSchema, req.query);
    res.json({ items: await service.search(actorOf(req), { ...filter, types: [...filter.types] }) });
  }),
);

searchRouter.get(
  '/suggest',
  asyncHandler(async (req, res) => {
    const { q, limit } = parseQuery(
      z.object({ q: z.string().trim().min(1).max(80), limit: z.coerce.number().int().min(1).max(20).default(8) }),
      req.query,
    );
    res.json(await service.suggest(actorOf(req), q, limit));
  }),
);
