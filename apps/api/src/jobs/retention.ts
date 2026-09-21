import { query, queryRows } from '../db/pool.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export interface RetentionRunResult {
  partitionsDropped: string[];
  messagesSoftPurged: number;
  attachmentsPurged: number;
  notificationsPurged: number;
  auditLogsPurged: number;
  partitionsCreated: string[];
  dryRun: boolean;
}

/**
 * Enforces the 365-day conversation retention requirement.
 *
 * Messages live in monthly partitions, so anything wholly older than the
 * retention window is removed by dropping its partition: a metadata
 * operation that reclaims the space instantly and leaves no dead tuples for
 * autovacuum. Rows inside the *current* boundary partition (partly inside
 * the window) are deleted individually.
 */
export async function runRetention(options: { dryRun?: boolean } = {}): Promise<RetentionRunResult> {
  const result: RetentionRunResult = {
    partitionsDropped: [],
    messagesSoftPurged: 0,
    attachmentsPurged: 0,
    notificationsPurged: 0,
    auditLogsPurged: 0,
    partitionsCreated: [],
    dryRun: options.dryRun ?? false,
  };

  // Per-org policy overrides the default, but the job runs cluster-wide, so
  // the most permissive enforced policy decides what may be dropped.
  const policies = await queryRows<{ scope: string; retention_days: number; enforced: boolean }>(
    `SELECT scope, max(retention_days) AS retention_days, bool_or(enforced) AS enforced
       FROM retention_policies GROUP BY scope`,
  );
  const policyFor = (scope: string, fallback: number): { days: number; enforced: boolean } => {
    const match = policies.find((policy) => policy.scope === scope);
    return { days: match?.retention_days ?? fallback, enforced: match?.enforced ?? true };
  };

  const messagePolicy = policyFor('messages', env().MESSAGE_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - messagePolicy.days * 86_400_000);

  // 1. Whole partitions that end before the cutoff.
  const partitions = await queryRows<{ partition_name: string; upper_bound: string }>(
    `
    SELECT c.relname AS partition_name,
           -- The upper bound literal out of the partition expression.
           substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([^'']+)''\\)') AS upper_bound
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE parent.relname = 'messages'
    `,
  );

  for (const partition of partitions) {
    if (!partition.upper_bound) continue;
    const upper = new Date(partition.upper_bound);
    if (Number.isNaN(upper.getTime()) || upper > cutoff) continue;

    if (!messagePolicy.enforced || result.dryRun) {
      logger.info({ partition: partition.partition_name }, 'retention dry run: partition would be dropped');
      result.partitionsDropped.push(`${partition.partition_name} (dry run)`);
      continue;
    }

    // DETACH first so the drop never blocks readers of the parent table.
    await query(`ALTER TABLE messages DETACH PARTITION ${quoteIdent(partition.partition_name)}`);
    await query(`DROP TABLE ${quoteIdent(partition.partition_name)}`);
    result.partitionsDropped.push(partition.partition_name);
    logger.info({ partition: partition.partition_name }, 'retention: dropped expired message partition');
  }

  // 2. Rows older than the cutoff inside the boundary partition.
  if (messagePolicy.enforced && !result.dryRun) {
    const { rowCount } = await query('DELETE FROM messages WHERE created_at < $1', [cutoff]);
    result.messagesSoftPurged = rowCount ?? 0;
  }

  // 3. Orphaned attachments: uploads that were never linked to anything.
  //    Their storage objects are removed by the bucket lifecycle rule keyed
  //    on the same prefix (see docs/13-search-and-retention-strategy.md).
  const attachmentPolicy = policyFor('attachments', messagePolicy.days);
  if (attachmentPolicy.enforced && !result.dryRun) {
    const { rowCount } = await query(
      `
      DELETE FROM attachments
       WHERE message_id IS NULL AND task_id IS NULL AND comment_id IS NULL
         AND created_at < now() - INTERVAL '1 day'
      `,
    );
    result.attachmentsPurged = rowCount ?? 0;
  }

  // 4. Read notifications and expired audit logs.
  const notificationPolicy = policyFor('notifications', 90);
  if (notificationPolicy.enforced && !result.dryRun) {
    const { rowCount } = await query(
      `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - ($1 || ' days')::interval`,
      [notificationPolicy.days],
    );
    result.notificationsPurged = rowCount ?? 0;
  }

  const auditPolicy = policyFor('audit_logs', 730);
  if (auditPolicy.enforced && !result.dryRun) {
    const { rowCount } = await query(
      `DELETE FROM audit_logs WHERE created_at < now() - ($1 || ' days')::interval`,
      [auditPolicy.days],
    );
    result.auditLogsPurged = rowCount ?? 0;
  }

  // 5. Keep two months of partitions ahead so an insert never fails for want
  //    of a partition.
  const now = new Date();
  for (const monthOffset of [0, 1, 2]) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
    const rows = await queryRows<{ ensure_message_partition: string }>(
      'SELECT ensure_message_partition($1::date)',
      [day.toISOString().slice(0, 10)],
    );
    const created = rows[0]?.ensure_message_partition;
    if (created) result.partitionsCreated.push(created);
  }

  // Expired refresh tokens are not user data but they do accumulate.
  await query(`DELETE FROM refresh_tokens WHERE expires_at < now() - INTERVAL '30 days'`);
  // Old dedupe markers have served their purpose after a week.
  await query(`DELETE FROM notification_dedupe WHERE day < CURRENT_DATE - 7`);

  logger.info({ ...result }, 'retention job complete');
  return result;
}

/** Identifiers come from pg_class, but quoting them keeps the DDL safe. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
