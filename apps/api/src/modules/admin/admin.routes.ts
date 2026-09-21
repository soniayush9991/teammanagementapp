import { Router } from 'express';
import { z } from 'zod';
import { ROLE_PERMISSIONS } from '@teamspace/shared';
import { query, queryRows } from '../../db/pool.js';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { recordAudit } from '../../lib/audit.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

/** The permission matrix, so the UI can render it instead of hard-coding it. */
adminRouter.get(
  '/permissions',
  asyncHandler(async (_req, res) => {
    res.json({ matrix: ROLE_PERMISSIONS });
  }),
);

const auditSchema = z.object({
  actorId: uuid.optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

adminRouter.get(
  '/audit-logs',
  requirePermission('audit:read'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(auditSchema, req.query);
    const actor = actorOf(req);
    const conditions = ['al.org_id = $1'];
    const params: unknown[] = [actor.orgId];

    if (filter.actorId) {
      params.push(filter.actorId);
      conditions.push(`al.actor_id = $${params.length}`);
    }
    if (filter.action) {
      params.push(`${filter.action}%`);
      conditions.push(`al.action LIKE $${params.length}`);
    }
    if (filter.entityType) {
      params.push(filter.entityType);
      conditions.push(`al.entity_type = $${params.length}`);
    }
    if (filter.entityId) {
      params.push(filter.entityId);
      conditions.push(`al.entity_id = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      conditions.push(`al.created_at >= $${params.length}::date`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`al.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    params.push(filter.limit, filter.offset);

    const items = await queryRows(
      `
      SELECT al.id::text AS id, al.action, al.entity_type AS "entityType", al.entity_id AS "entityId",
             al.actor_id AS "actorId", u.display_name AS "actorName", al.ip_address AS "ipAddress",
             al.metadata, al.created_at AS "createdAt"
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.actor_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
    );
    res.json({ items });
  }),
);

adminRouter.get(
  '/retention-policies',
  requirePermission('retention:configure'),
  asyncHandler(async (req, res) => {
    const items = await queryRows(
      `SELECT scope, retention_days AS "retentionDays", enforced, updated_at AS "updatedAt"
         FROM retention_policies WHERE org_id = $1 ORDER BY scope`,
      [actorOf(req).orgId],
    );
    res.json({ items });
  }),
);

adminRouter.put(
  '/retention-policies',
  requirePermission('retention:configure'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        scope: z.enum(['messages', 'attachments', 'notifications', 'audit_logs']),
        retentionDays: z.number().int().min(1).max(3650),
        enforced: z.boolean().default(true),
      }),
      req.body,
    );
    const actor = actorOf(req);

    await query(
      `
      INSERT INTO retention_policies (org_id, scope, retention_days, enforced, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (org_id, scope)
        DO UPDATE SET retention_days = EXCLUDED.retention_days, enforced = EXCLUDED.enforced,
                      updated_by = EXCLUDED.updated_by, updated_at = now()
      `,
      [actor.orgId, body.scope, body.retentionDays, body.enforced, actor.id],
    );
    // Retention changes are exactly what an auditor comes looking for.
    await recordAudit({
      orgId: actor.orgId,
      actorId: actor.id,
      action: 'retention.updated',
      entityType: 'retention_policy',
      entityId: body.scope,
      metadata: { retentionDays: body.retentionDays, enforced: body.enforced },
    });
    res.status(204).send();
  }),
);

const orgSettingsSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  timezone: z.string().trim().max(64).optional(),
  defaultWeeklyCapacityHours: z.number().min(0).max(168).optional(),
  allowMemberGroupCreation: z.boolean().optional(),
});

adminRouter.patch(
  '/organization',
  requirePermission('org:configure'),
  asyncHandler(async (req, res) => {
    const body = parseBody(orgSettingsSchema, req.body);
    const actor = actorOf(req);
    const updates: string[] = [];
    const params: unknown[] = [actor.orgId];

    if (body.name !== undefined) {
      params.push(body.name);
      updates.push(`name = $${params.length}`);
    }
    if (body.timezone !== undefined) {
      params.push(body.timezone);
      updates.push(`timezone = $${params.length}`);
    }
    if (body.defaultWeeklyCapacityHours !== undefined) {
      params.push(body.defaultWeeklyCapacityHours);
      updates.push(`default_weekly_capacity_hours = $${params.length}`);
    }
    if (body.allowMemberGroupCreation !== undefined) {
      params.push(body.allowMemberGroupCreation);
      updates.push(`allow_member_group_creation = $${params.length}`);
    }

    if (updates.length > 0) {
      await query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $1`, params);
      await recordAudit({
        orgId: actor.orgId,
        actorId: actor.id,
        action: 'org.settings_updated',
        entityType: 'organization',
        entityId: actor.orgId,
        metadata: { changes: body },
      });
    }
    res.status(204).send();
  }),
);

const holidaySchema = z.object({
  name: z.string().trim().min(1).max(120),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  region: z.string().trim().max(40).nullish(),
  hours: z.number().positive().max(24).default(8),
});

adminRouter.post(
  '/holidays',
  requirePermission('org:configure'),
  asyncHandler(async (req, res) => {
    const body = parseBody(holidaySchema, req.body);
    await query(
      `INSERT INTO holidays (org_id, name, day, region, hours) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, day, region) DO UPDATE SET name = EXCLUDED.name, hours = EXCLUDED.hours`,
      [actorOf(req).orgId, body.name, body.day, body.region ?? null, body.hours],
    );
    res.status(201).json({ ok: true });
  }),
);

adminRouter.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const items = await queryRows(
      `SELECT id, name, day, region, hours FROM holidays WHERE org_id = $1 ORDER BY day`,
      [actorOf(req).orgId],
    );
    res.json({ items });
  }),
);
