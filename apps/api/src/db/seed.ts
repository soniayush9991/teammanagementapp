// Must precede every other import (see loadDotenv).
import '../loadDotenv.js';
import { isoWeekKey, addDays } from '@teamspace/shared';
import { closePool, withTransaction } from './pool.js';
import { isMainModule } from '../lib/isMain.js';
import { hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import { runMigrations } from './migrate.js';

/**
 * Demo data: one organization, a manager with six reportees across two teams,
 * a realistic spread of tasks (including an overloaded person and an
 * underutilized one so the capacity colours are visible), leave, channels and
 * a conversation with threads and reactions.
 *
 * Idempotent: re-running wipes the demo org and rebuilds it.
 */
const DEMO_PASSWORD = 'TeamSpace!2026';

interface SeedPerson {
  key: string;
  email: string;
  displayName: string;
  role: 'admin' | 'manager' | 'member';
  jobTitle: string;
  skills: string[];
  weeklyCapacityHours: number;
}

const PEOPLE: SeedPerson[] = [
  { key: 'admin', email: 'admin@teamspace.dev', displayName: 'Ana Duarte', role: 'admin', jobTitle: 'Head of Engineering', skills: ['leadership'], weeklyCapacityHours: 40 },
  { key: 'manager', email: 'maya@teamspace.dev', displayName: 'Maya Okonkwo', role: 'manager', jobTitle: 'Engineering Manager', skills: ['leadership', 'planning'], weeklyCapacityHours: 40 },
  { key: 'dev1', email: 'sam@teamspace.dev', displayName: 'Sam Rivera', role: 'member', jobTitle: 'Senior Frontend Engineer', skills: ['react', 'typescript', 'accessibility'], weeklyCapacityHours: 40 },
  { key: 'dev2', email: 'priya@teamspace.dev', displayName: 'Priya Nair', role: 'member', jobTitle: 'Backend Engineer', skills: ['node', 'postgres', 'kubernetes'], weeklyCapacityHours: 40 },
  { key: 'dev3', email: 'tom@teamspace.dev', displayName: 'Tom Berg', role: 'member', jobTitle: 'Full-stack Engineer', skills: ['react', 'node', 'postgres'], weeklyCapacityHours: 32 },
  { key: 'dev4', email: 'lin@teamspace.dev', displayName: 'Lin Chen', role: 'member', jobTitle: 'QA Engineer', skills: ['testing', 'automation'], weeklyCapacityHours: 40 },
  { key: 'des1', email: 'noor@teamspace.dev', displayName: 'Noor Haddad', role: 'member', jobTitle: 'Product Designer', skills: ['figma', 'design-systems', 'accessibility'], weeklyCapacityHours: 40 },
];

export async function seed(): Promise<void> {
  await runMigrations();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await withTransaction(async (client) => {
    // Rebuild from scratch so the demo is deterministic.
    await client.query(`DELETE FROM organizations WHERE slug = 'teamspace-demo'`);

    const { rows: orgRows } = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone) VALUES ('TeamSpace Demo', 'teamspace-demo', 'Europe/Lisbon') RETURNING id`,
    );
    const orgId = orgRows[0]?.id;
    if (!orgId) throw new Error('could not create the demo organization');

    const ids = new Map<string, string>();
    for (const person of PEOPLE) {
      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO users (org_id, email, password_hash, display_name, role, job_title, weekly_capacity_hours, timezone)
        VALUES ($1, $2, $3, $4, $5::user_role, $6, $7, 'Europe/Lisbon')
        RETURNING id
        `,
        [orgId, person.email, passwordHash, person.displayName, person.role, person.jobTitle, person.weeklyCapacityHours],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`could not create ${person.email}`);
      ids.set(person.key, id);

      for (const skill of person.skills) {
        await client.query(
          `INSERT INTO skills (org_id, name) VALUES ($1, $2) ON CONFLICT (org_id, name) DO NOTHING`,
          [orgId, skill],
        );
        await client.query(
          `
          INSERT INTO user_skills (user_id, skill_id, proficiency)
          SELECT $1, s.id, 4 FROM skills s WHERE s.org_id = $2 AND s.name = $3
          `,
          [id, orgId, skill],
        );
      }
    }

    const manager = ids.get('manager');
    const admin = ids.get('admin');
    if (!manager || !admin) throw new Error('seed people missing');

    // Reporting line: everyone but the admin reports to Maya.
    for (const person of PEOPLE) {
      if (person.key === 'admin' || person.key === 'manager') continue;
      await client.query('UPDATE users SET manager_id = $2 WHERE id = $1', [ids.get(person.key), manager]);
    }
    await client.query('UPDATE users SET manager_id = $2 WHERE id = $1', [manager, admin]);

    // Two teams.
    const { rows: teamRows } = await client.query<{ id: string }>(
      `
      INSERT INTO teams (org_id, name, description, manager_id, key_prefix)
      VALUES ($1, 'Platform', 'Core services, data model and APIs', $2, 'PLAT'),
             ($1, 'Experience', 'Web client, design system and accessibility', $2, 'EXP')
      RETURNING id
      `,
      [orgId, manager],
    );
    const platformId = teamRows[0]?.id;
    const experienceId = teamRows[1]?.id;
    if (!platformId || !experienceId) throw new Error('could not create the demo teams');

    const platformMembers = ['manager', 'dev2', 'dev3', 'dev4'];
    const experienceMembers = ['manager', 'dev1', 'des1', 'dev3'];
    for (const key of platformMembers) {
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role_in_team) VALUES ($1, $2, $3)`,
        [platformId, ids.get(key), key === 'manager' ? 'manager' : 'member'],
      );
    }
    for (const key of experienceMembers) {
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role_in_team) VALUES ($1, $2, $3)`,
        [experienceId, ids.get(key), key === 'manager' ? 'manager' : 'member'],
      );
    }

    // Tasks. Priya is deliberately over-allocated and Lin under-allocated so
    // the dashboard shows red and blue bands out of the box.
    const today = new Date();
    const taskPlan: {
      team: string;
      title: string;
      description: string;
      assignee: string;
      status: string;
      priority: string;
      dueInDays: number;
      hours: number;
      labels: string[];
    }[] = [
      { team: platformId, title: 'Partition the messages table by month', description: 'Retention needs partition drops rather than bulk deletes.', assignee: 'dev2', status: 'in_progress', priority: 'high', dueInDays: 2, hours: 16, labels: ['postgres', 'retention'] },
      { team: platformId, title: 'Add full-text search indexes for conversations', description: 'GIN index on the message search vector plus ranking.', assignee: 'dev2', status: 'in_progress', priority: 'urgent', dueInDays: 1, hours: 12, labels: ['postgres', 'search'] },
      { team: platformId, title: 'Refresh token rotation and reuse detection', description: 'Rotate on use, revoke the family on replay.', assignee: 'dev2', status: 'todo', priority: 'high', dueInDays: 3, hours: 14, labels: ['node', 'security'] },
      { team: platformId, title: 'Capacity rollup endpoint', description: 'Team utilization for the manager dashboard.', assignee: 'dev3', status: 'in_review', priority: 'medium', dueInDays: 4, hours: 8, labels: ['node'] },
      { team: platformId, title: 'Nightly retention job', description: 'Drop expired partitions, purge orphan uploads.', assignee: 'dev3', status: 'todo', priority: 'medium', dueInDays: 6, hours: 6, labels: ['node'] },
      { team: platformId, title: 'Regression suite for capacity math', description: 'Cover leave, holidays and over-allocation.', assignee: 'dev4', status: 'todo', priority: 'medium', dueInDays: 5, hours: 5, labels: ['testing'] },
      { team: platformId, title: 'Overdue reminder digest', description: 'One notice per task per day, deduped.', assignee: 'dev4', status: 'backlog', priority: 'low', dueInDays: 12, hours: 4, labels: ['node'] },
      { team: experienceId, title: 'Kanban board with drag and drop', description: 'Keyboard-accessible column moves.', assignee: 'dev1', status: 'in_progress', priority: 'high', dueInDays: 3, hours: 18, labels: ['react', 'accessibility'] },
      { team: experienceId, title: 'Capacity planner drag-to-assign', description: 'Show projected utilization while dragging.', assignee: 'dev1', status: 'todo', priority: 'high', dueInDays: 7, hours: 14, labels: ['react'] },
      { team: experienceId, title: 'Chat thread panel', description: 'Threaded replies, reactions, typing indicator.', assignee: 'dev1', status: 'todo', priority: 'medium', dueInDays: 9, hours: 12, labels: ['react'] },
      { team: experienceId, title: 'Design tokens for utilization bands', description: 'Colour plus icon, never colour alone.', assignee: 'des1', status: 'in_review', priority: 'medium', dueInDays: 2, hours: 6, labels: ['figma', 'design-systems'] },
      { team: experienceId, title: 'Empty and error states for reports', description: 'Every table needs a zero state.', assignee: 'des1', status: 'todo', priority: 'low', dueInDays: 10, hours: 5, labels: ['figma'] },
      { team: experienceId, title: 'Accessibility audit of the dashboards', description: 'Contrast, focus order, screen reader labels.', assignee: 'des1', status: 'backlog', priority: 'medium', dueInDays: 14, hours: 8, labels: ['accessibility'] },
      { team: platformId, title: 'Document the API surface', description: 'Request and response examples per endpoint.', assignee: 'manager', status: 'done', priority: 'low', dueInDays: -3, hours: 4, labels: [] },
      { team: experienceId, title: 'Fix overdue badge contrast', description: 'Red on amber failed AA.', assignee: 'dev1', status: 'done', priority: 'medium', dueInDays: -5, hours: 2, labels: ['accessibility'] },
      { team: platformId, title: 'Stale WebSocket connections linger', description: 'Heartbeat and terminate dead sockets.', assignee: 'dev3', status: 'todo', priority: 'high', dueInDays: -2, hours: 6, labels: ['node'] },
    ];

    const taskIds: string[] = [];
    for (const plan of taskPlan) {
      const { rows: keyRows } = await client.query<{ key: string }>('SELECT next_task_key($1) AS key', [plan.team]);
      const key = keyRows[0]?.key;
      if (!key) throw new Error('could not allocate a task key');

      const dueDate = addDays(today, plan.dueInDays).toISOString().slice(0, 10);
      const isDone = plan.status === 'done';
      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO tasks (org_id, team_id, key, title, description, status, priority, created_by,
                           due_date, estimated_hours, remaining_hours, logged_hours, completed_at)
        VALUES ($1, $2, $3, $4, $5, $6::task_status, $7::task_priority, $8, $9, $10::numeric,
                CASE WHEN $6::task_status = 'done' THEN 0 ELSE $10::numeric END,
                CASE WHEN $6::task_status = 'done' THEN $10::numeric ELSE 0 END,
                CASE WHEN $6::task_status = 'done' THEN now() - INTERVAL '2 days' ELSE NULL END)
        RETURNING id
        `,
        [orgId, plan.team, key, plan.title, plan.description, plan.status, plan.priority, manager, dueDate, plan.hours],
      );
      const taskId = rows[0]?.id;
      if (!taskId) throw new Error(`could not create task ${key}`);
      taskIds.push(taskId);

      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, allocated_hours, assigned_by) VALUES ($1, $2, $3, $4)`,
        [taskId, ids.get(plan.assignee), isDone ? 0 : plan.hours, manager],
      );
      await client.query(
        `INSERT INTO assignment_events (task_id, user_id, actor_id, action) VALUES ($1, $2, $3, 'assigned')`,
        [taskId, ids.get(plan.assignee), manager],
      );
      await client.query(
        `INSERT INTO task_activity (task_id, actor_id, action, to_value) VALUES ($1, $2, 'created', $3)`,
        [taskId, manager, plan.title],
      );

      for (const label of plan.labels) {
        await client.query(
          `INSERT INTO labels (org_id, name) VALUES ($1, $2) ON CONFLICT (org_id, name) DO NOTHING`,
          [orgId, label],
        );
        await client.query(
          `INSERT INTO task_labels (task_id, label_id) SELECT $1, l.id FROM labels l WHERE l.org_id = $2 AND l.name = $3`,
          [taskId, orgId, label],
        );
      }
    }

    // Subtasks under the Kanban task.
    const kanbanTaskId = taskIds[7];
    if (kanbanTaskId) {
      for (const [index, subtitle] of ['Column layout', 'Drag handlers', 'Keyboard moves'].entries()) {
        const { rows: keyRows } = await client.query<{ key: string }>('SELECT next_task_key($1) AS key', [
          experienceId,
        ]);
        await client.query(
          `
          INSERT INTO tasks (org_id, team_id, key, parent_task_id, title, status, priority, created_by,
                             estimated_hours, remaining_hours, completed_at)
          VALUES ($1, $2, $3, $4, $5, $6::task_status, 'medium', $7, 6, CASE WHEN $6::task_status = 'done' THEN 0 ELSE 6 END,
                  CASE WHEN $6::task_status = 'done' THEN now() ELSE NULL END)
          `,
          [
            orgId,
            experienceId,
            keyRows[0]?.key,
            kanbanTaskId,
            subtitle,
            index === 0 ? 'done' : 'todo',
            ids.get('dev1'),
          ],
        );
      }
    }

    // A dependency and a comment thread.
    if (taskIds[0] && taskIds[4]) {
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, type) VALUES ($1, $2, 'blocks')`,
        [taskIds[4], taskIds[0]],
      );
    }
    if (taskIds[1]) {
      await client.query(
        `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3), ($1, $4, $5)`,
        [
          taskIds[1],
          manager,
          'Can we get ranking weights in before the demo? Title should beat description.',
          ids.get('dev2'),
          'Yes — setweight A on title and key, B on description. Pushing this afternoon.',
        ],
      );
    }

    // Leave: Tom is off for two days this week, which tightens his capacity.
    await client.query(
      `
      INSERT INTO leave_requests (user_id, kind, status, start_date, end_date, hours_per_day, decided_by, decided_at, note)
      VALUES ($1, 'vacation', 'approved', $2, $3, 8, $4, now(), 'Long weekend')
      `,
      [
        ids.get('dev3'),
        addDays(today, 1).toISOString().slice(0, 10),
        addDays(today, 2).toISOString().slice(0, 10),
        manager,
      ],
    );
    await client.query(
      `
      INSERT INTO leave_requests (user_id, kind, status, start_date, end_date, hours_per_day, note)
      VALUES ($1, 'vacation', 'pending', $2, $3, 8, 'Family visit')
      `,
      [
        ids.get('dev4'),
        addDays(today, 20).toISOString().slice(0, 10),
        addDays(today, 24).toISOString().slice(0, 10),
      ],
    );

    // A per-week capacity override, to show the mechanism.
    await client.query(
      `INSERT INTO capacity_weeks (user_id, week_key, capacity_hours, note, updated_by) VALUES ($1, $2, 24, 'Ramping back from leave', $3)`,
      [ids.get('des1'), isoWeekKey(addDays(today, 7)), manager],
    );

    // Conversations: a public channel, a private group and a DM.
    const { rows: convRows } = await client.query<{ id: string }>(
      `
      INSERT INTO conversations (org_id, kind, visibility, name, topic, team_id, created_by)
      VALUES ($1, 'channel', 'public', 'general', 'Anything and everything', NULL, $2),
             ($1, 'channel', 'public', 'platform-standup', 'Daily async standup', $3, $2),
             ($1, 'group', 'private', 'Q4 planning', 'Roadmap and staffing', NULL, $2)
      RETURNING id
      `,
      [orgId, manager, platformId],
    );
    const generalId = convRows[0]?.id;
    const standupId = convRows[1]?.id;
    const planningId = convRows[2]?.id;
    if (!generalId || !standupId || !planningId) throw new Error('could not create conversations');

    for (const person of PEOPLE) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)`,
        [generalId, ids.get(person.key), person.key === 'manager' ? 'owner' : 'member'],
      );
    }
    for (const key of platformMembers) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)`,
        [standupId, ids.get(key), key === 'manager' ? 'owner' : 'member'],
      );
    }
    for (const key of ['manager', 'admin', 'des1']) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)`,
        [planningId, ids.get(key), key === 'manager' ? 'owner' : 'member'],
      );
    }

    // A DM between the manager and Priya.
    const dmParticipants = [manager, ids.get('dev2')].filter((id): id is string => Boolean(id)).sort();
    const { rows: dmRows } = await client.query<{ id: string }>(
      `INSERT INTO conversations (org_id, kind, visibility, created_by) VALUES ($1, 'dm', 'private', $2) RETURNING id`,
      [orgId, manager],
    );
    const dmId = dmRows[0]?.id;
    if (dmId && dmParticipants[0] && dmParticipants[1]) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) SELECT $1, unnest($2::uuid[]), 'member'`,
        [dmId, dmParticipants],
      );
      await client.query(
        `INSERT INTO dm_pairs (conversation_id, org_id, user_a, user_b) VALUES ($1, $2, $3, $4)`,
        [dmId, orgId, dmParticipants[0], dmParticipants[1]],
      );
    }

    // Messages, including a thread, a mention and a pin.
    const { rows: rootRows } = await client.query<{ id: string; created_at: Date }>(
      `
      INSERT INTO messages (conversation_id, author_id, body, created_at)
      VALUES ($1, $2, 'Standup: partitioning is in review, search indexes next.', now() - INTERVAL '3 hours')
      RETURNING id, created_at
      `,
      [standupId, ids.get('dev2')],
    );
    const rootMessage = rootRows[0];
    if (rootMessage) {
      await client.query(
        `
        INSERT INTO messages (conversation_id, author_id, parent_message_id, body, mentions, created_at)
        VALUES ($1, $2, $3, $4, $5::uuid[], now() - INTERVAL '2 hours')
        `,
        [
          standupId,
          manager,
          rootMessage.id,
          `Nice. @[Priya Nair](${ids.get('dev2')}) can you note the retention window in the runbook?`,
          [ids.get('dev2')],
        ],
      );
      await client.query(
        `
        INSERT INTO message_reactions (message_id, message_created_at, user_id, emoji)
        SELECT m.id, m.created_at, $2, '🚀' FROM messages m WHERE m.id = $1
        `,
        [rootMessage.id, manager],
      );
    }

    await client.query(
      `
      INSERT INTO messages (conversation_id, author_id, body, pinned_at, pinned_by, created_at)
      VALUES ($1, $2, 'Welcome to TeamSpace. Capacity colours: green healthy, amber near capacity, red overloaded.',
              now() - INTERVAL '1 day', $2, now() - INTERVAL '1 day')
      `,
      [generalId, manager],
    );
    await client.query(
      `
      INSERT INTO messages (conversation_id, author_id, body, created_at)
      VALUES ($1, $2, 'Priya, you are at 105% this week — want me to move the reminder digest to Lin?', now() - INTERVAL '4 hours'),
             ($1, $3, 'Yes please, that would help.', now() - INTERVAL '3 hours')
      `,
      [dmId, manager, ids.get('dev2')],
    );

    // Retention policy rows, with the 365-day message requirement explicit.
    await client.query(
      `
      INSERT INTO retention_policies (org_id, scope, retention_days, updated_by)
      VALUES ($1, 'messages', 365, $2), ($1, 'attachments', 365, $2),
             ($1, 'notifications', 90, $2), ($1, 'audit_logs', 730, $2)
      `,
      [orgId, admin],
    );

    // A public holiday inside the planning horizon.
    await client.query(
      `INSERT INTO holidays (org_id, name, day, hours) VALUES ($1, 'Company day off', $2, 8)`,
      [orgId, addDays(today, 10).toISOString().slice(0, 10)],
    );

    logger.info({ orgId, people: PEOPLE.length, tasks: taskPlan.length }, 'demo data seeded');
  });
}

if (isMainModule(import.meta.url)) {
  seed()
    .then(() => {
      console.log('Demo data seeded.');
      console.log('  Admin:   admin@teamspace.dev');
      console.log('  Manager: maya@teamspace.dev');
      console.log('  Member:  sam@teamspace.dev');
      console.log(`  Password for every demo account: ${DEMO_PASSWORD}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
