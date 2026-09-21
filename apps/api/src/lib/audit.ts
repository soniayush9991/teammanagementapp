import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';
import { logger } from './logger.js';

export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends to the audit trail. Pass the transaction client when the audit entry
 * must be atomic with the change it describes (role grants, deletions);
 * otherwise it is written on the pool and a failure is logged rather than
 * failing the user's request.
 */
export async function recordAudit(entry: AuditEntry, client?: PoolClient): Promise<void> {
  const sql = `
    INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `;
  const params = [
    entry.orgId,
    entry.actorId,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.ipAddress ?? null,
    entry.userAgent ?? null,
    JSON.stringify(entry.metadata ?? {}),
  ];

  if (client) {
    await client.query(sql, params);
    return;
  }

  try {
    await query(sql, params);
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'failed to write audit log');
  }
}
