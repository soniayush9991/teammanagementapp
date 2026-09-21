import type { SearchHit } from '@teamspace/shared';
import { queryRows } from '../../db/pool.js';
import { toPlainText } from '../../lib/mentions.js';
import type { AuthenticatedActor } from '../../middleware/auth.js';

export interface SearchFilter {
  q: string;
  types: ('task' | 'message' | 'attachment')[];
  /** Restrict to one conversation or one author. */
  conversationId?: string;
  authorId?: string;
  teamId?: string;
  from?: string;
  to?: string;
  limit: number;
}

/**
 * Cross-entity search. Every branch carries its own visibility predicate, so
 * a hit can never surface a task in a team the caller is not on, or a message
 * from a conversation they are not a member of (public channels excepted).
 *
 * `websearch_to_tsquery` is used rather than `to_tsquery` so end users can
 * type quoted phrases and `-exclusions` without hitting a syntax error.
 */
export async function search(actor: AuthenticatedActor, filter: SearchFilter): Promise<SearchHit[]> {
  const branches: string[] = [];
  // Parameters are appended as branches need them. Postgres cannot infer the
  // type of a parameter that no branch references, so sending a fixed list
  // would fail whenever the caller narrows the search to a single type.
  const params: unknown[] = [actor.orgId, actor.id, filter.q];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const dateClause = (column: string): string => {
    const clauses: string[] = [];
    if (filter.from) {
      params.push(filter.from);
      clauses.push(`${column} >= $${params.length}::date`);
    }
    if (filter.to) {
      params.push(filter.to);
      clauses.push(`${column} < ($${params.length}::date + INTERVAL '1 day')`);
    }
    return clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
  };

  if (filter.types.includes('task')) {
    const role = param(actor.role);
    let extra = '';
    if (filter.teamId) {
      params.push(filter.teamId);
      extra += ` AND t.team_id = $${params.length}`;
    }
    if (filter.authorId) {
      params.push(filter.authorId);
      extra += ` AND (t.created_by = $${params.length}
                      OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${params.length}))`;
    }
    branches.push(`
      SELECT 'task' AS type, t.id::text AS id, t.key || ' ' || t.title AS title,
             ts_headline('english', COALESCE(t.description, t.title),
                         websearch_to_tsquery('english', $3),
                         'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8') AS snippet,
             '/tasks/' || t.key AS link,
             ts_rank(t.search_vector, websearch_to_tsquery('english', $3)) AS rank,
             t.created_at,
             tm.name AS context_label
        FROM tasks t
        JOIN teams tm ON tm.id = t.team_id
       WHERE t.org_id = $1
         AND t.search_vector @@ websearch_to_tsquery('english', $3)
         AND (${role} = 'admin'
              OR EXISTS (SELECT 1 FROM team_members x WHERE x.team_id = t.team_id AND x.user_id = $2)
              OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $2))
         ${extra}
         ${dateClause('t.created_at')}
    `);
  }

  if (filter.types.includes('message')) {
    let extra = '';
    if (filter.conversationId) {
      params.push(filter.conversationId);
      extra += ` AND m.conversation_id = $${params.length}`;
    }
    if (filter.authorId) {
      params.push(filter.authorId);
      extra += ` AND m.author_id = $${params.length}`;
    }
    branches.push(`
      SELECT 'message' AS type, m.id::text AS id,
             COALESCE(c.name, 'Direct message') AS title,
             -- Mention markup is rewritten to plain @Name *before* highlighting:
             -- ts_headline truncates to a window and would otherwise cut a
             -- @[Name](uuid) token in half, leaving raw markup on screen.
             ts_headline('english',
                         regexp_replace(m.body, '@\\[([^\\]]+)\\]\\([0-9a-fA-F-]{36}\\)', '@\\1', 'g'),
                         websearch_to_tsquery('english', $3),
                         'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8') AS snippet,
             '/chat/' || m.conversation_id::text || '?message=' || m.id::text AS link,
             ts_rank(m.search_vector, websearch_to_tsquery('english', $3)) AS rank,
             m.created_at,
             COALESCE(c.name, au.display_name) AS context_label
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN users au ON au.id = m.author_id
       WHERE c.org_id = $1
         AND m.deleted_at IS NULL
         AND m.search_vector @@ websearch_to_tsquery('english', $3)
         AND (EXISTS (SELECT 1 FROM conversation_members cm
                       WHERE cm.conversation_id = c.id AND cm.user_id = $2)
              OR (c.kind = 'channel' AND c.visibility = 'public'))
         ${extra}
         ${dateClause('m.created_at')}
    `);
  }

  if (filter.types.includes('attachment')) {
    const role = param(actor.role);
    branches.push(`
      SELECT 'attachment' AS type, a.id::text AS id, a.file_name AS title,
             a.content_type AS snippet,
             CASE WHEN a.task_id IS NOT NULL THEN '/tasks/' || (SELECT key FROM tasks WHERE id = a.task_id)
                  WHEN a.message_id IS NOT NULL THEN '/chat/' || (SELECT conversation_id::text FROM messages WHERE id = a.message_id LIMIT 1)
                  ELSE '/files' END AS link,
             ts_rank(a.search_vector, websearch_to_tsquery('english', $3)) AS rank,
             a.created_at,
             NULL AS context_label
        FROM attachments a
       WHERE a.org_id = $1
         AND a.search_vector @@ websearch_to_tsquery('english', $3)
         AND (
           -- Same visibility rules as the entity the file hangs off.
           (${role} = 'admin')
           OR (a.task_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM tasks t JOIN team_members x ON x.team_id = t.team_id
                  WHERE t.id = a.task_id AND x.user_id = $2))
           OR (a.message_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM messages m
                   JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
                  WHERE m.id = a.message_id AND cm.user_id = $2))
         )
         ${dateClause('a.created_at')}
    `);
  }

  if (branches.length === 0) return [];

  params.push(filter.limit);
  const rows = await queryRows<{
    type: SearchHit['type'];
    id: string;
    title: string;
    snippet: string;
    link: string;
    rank: number;
    created_at: Date;
    context_label: string | null;
  }>(
    `
    SELECT * FROM (
      ${branches.join('\n      UNION ALL\n')}
    ) results
    ORDER BY rank DESC, created_at DESC
    LIMIT $${params.length}
    `,
    params,
  );

  return rows.map((row) => ({
    type: row.type,
    id: row.id,
    title: row.title,
    // ts_headline works on the stored body, so a message snippet still holds
    // the @[Name](id) mention markup; render it as plain @Name.
    snippet: toPlainText(row.snippet),
    link: row.link,
    rank: Number(row.rank),
    createdAt: row.created_at.toISOString(),
    contextLabel: row.context_label,
  }));
}

/**
 * Typeahead for the composer's @mention picker and the quick switcher.
 * Trigram indexes make the ILIKE prefix match fast enough to run per keystroke.
 */
export async function suggest(
  actor: AuthenticatedActor,
  prefix: string,
  limit = 8,
): Promise<{ users: { id: string; displayName: string; avatarUrl: string | null }[]; tasks: { key: string; title: string }[] }> {
  const pattern = `%${prefix}%`;
  const [users, tasks] = await Promise.all([
    queryRows<{ id: string; display_name: string; avatar_url: string | null }>(
      `
      SELECT id, display_name, avatar_url
        FROM users
       WHERE org_id = $1 AND is_active AND (display_name ILIKE $2 OR email ILIKE $2)
       ORDER BY display_name
       LIMIT $3
      `,
      [actor.orgId, pattern, limit],
    ),
    queryRows<{ key: string; title: string }>(
      `
      SELECT t.key, t.title
        FROM tasks t
       WHERE t.org_id = $1
         AND (t.key ILIKE $2 OR t.title ILIKE $2)
         AND ($4 = 'admin' OR EXISTS (SELECT 1 FROM team_members x WHERE x.team_id = t.team_id AND x.user_id = $5))
       ORDER BY t.updated_at DESC
       LIMIT $3
      `,
      [actor.orgId, pattern, limit, actor.role, actor.id],
    ),
  ]);

  return {
    users: users.map((row) => ({ id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url })),
    tasks,
  };
}
