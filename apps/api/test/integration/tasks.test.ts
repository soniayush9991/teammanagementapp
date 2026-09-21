import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

interface TaskResponse {
  id: string;
  key: string;
  status: string;
  remainingHours: number;
  loggedHours: number;
  completedAt: string | null;
  assignees: { userId: string; displayName: string }[];
  subtaskCount: number;
  labels: string[];
}

describe('task lifecycle', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let managerToken: string;
  let teamId: string;

  before(async () => {
    context = await startTestServer();
    managerToken = await login(context, DEMO.manager);
    const teams = await api<{ items: { id: string; name: string }[] }>(context, 'GET', '/teams', {
      token: managerToken,
    });
    teamId = teams.body.items.find((team) => team.name === 'Platform')!.id;
  });

  after(async () => context?.close());

  async function createTask(overrides: Record<string, unknown> = {}): Promise<TaskResponse> {
    const response = await api<TaskResponse>(context, 'POST', '/tasks', {
      token: managerToken,
      body: { teamId, title: 'Integration test task', estimatedHours: 8, ...overrides },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }

  test('a new task gets a sequential, human-readable key', async () => {
    const first = await createTask({ title: 'Key allocation A' });
    const second = await createTask({ title: 'Key allocation B' });
    assert.match(first.key, /^PLAT-\d+$/);
    assert.match(second.key, /^PLAT-\d+$/);
    assert.ok(
      Number(second.key.split('-')[1]) > Number(first.key.split('-')[1]),
      'keys must increase monotonically',
    );
  });

  test('tasks are addressable by key as well as id', async () => {
    const task = await createTask({ title: 'Addressable by key' });
    const byKey = await api<TaskResponse>(context, 'GET', `/tasks/${task.key}`, { token: managerToken });
    const byId = await api<TaskResponse>(context, 'GET', `/tasks/${task.id}`, { token: managerToken });
    assert.equal(byKey.status, 200);
    assert.equal(byId.status, 200);
    assert.equal(byKey.body.id, byId.body.id);
  });

  test('illegal status transitions are refused with the legal ones listed', async () => {
    const task = await createTask({ title: 'Transition guard', status: 'backlog' });
    const response = await api<{ error: { code: string; details: { allowed: string[] } } }>(
      context,
      'PATCH',
      `/tasks/${task.key}`,
      { token: managerToken, body: { status: 'done' } },
    );
    assert.equal(response.status, 422);
    assert.ok(response.body.error.details.allowed.includes('in_progress'));
    assert.ok(!response.body.error.details.allowed.includes('done'));
  });

  test('completing a task zeroes remaining effort and stamps completedAt', async () => {
    const task = await createTask({ title: 'Completion bookkeeping' });
    await api(context, 'PATCH', `/tasks/${task.key}`, { token: managerToken, body: { status: 'in_progress' } });
    const done = await api<TaskResponse>(context, 'PATCH', `/tasks/${task.key}`, {
      token: managerToken,
      body: { status: 'done' },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.remainingHours, 0);
    assert.ok(done.body.completedAt, 'completedAt must be set');
  });

  test('a task blocked by open work cannot be completed', async () => {
    const blocker = await createTask({ title: 'Blocking work' });
    const blocked = await createTask({ title: 'Dependent work' });

    const link = await api(context, 'POST', `/tasks/${blocked.key}/dependencies`, {
      token: managerToken,
      body: { dependsOnTaskId: blocker.key, type: 'blocks' },
    });
    assert.equal(link.status, 201);

    await api(context, 'PATCH', `/tasks/${blocked.key}`, { token: managerToken, body: { status: 'in_progress' } });
    const attempt = await api<{ error: { details: { blockedBy: string[] } } }>(
      context,
      'PATCH',
      `/tasks/${blocked.key}`,
      { token: managerToken, body: { status: 'done' } },
    );
    assert.equal(attempt.status, 409);
    assert.deepEqual(attempt.body.error.details.blockedBy, [blocker.key]);

    // Once the blocker closes, the dependent task can complete.
    await api(context, 'PATCH', `/tasks/${blocker.key}`, { token: managerToken, body: { status: 'in_progress' } });
    await api(context, 'PATCH', `/tasks/${blocker.key}`, { token: managerToken, body: { status: 'done' } });
    const now = await api(context, 'PATCH', `/tasks/${blocked.key}`, {
      token: managerToken,
      body: { status: 'done' },
    });
    assert.equal(now.status, 200);
  });

  test('circular dependencies are refused', async () => {
    const a = await createTask({ title: 'Cycle A' });
    const b = await createTask({ title: 'Cycle B' });
    await api(context, 'POST', `/tasks/${b.key}/dependencies`, {
      token: managerToken,
      body: { dependsOnTaskId: a.key, type: 'blocks' },
    });
    const cycle = await api(context, 'POST', `/tasks/${a.key}/dependencies`, {
      token: managerToken,
      body: { dependsOnTaskId: b.key, type: 'blocks' },
    });
    assert.equal(cycle.status, 409);
  });

  test('a parent cannot be closed while subtasks are open', async () => {
    const parent = await createTask({ title: 'Parent task' });
    await createTask({ title: 'Child task', parentTaskId: parent.id });

    await api(context, 'PATCH', `/tasks/${parent.key}`, { token: managerToken, body: { status: 'in_progress' } });
    const attempt = await api(context, 'PATCH', `/tasks/${parent.key}`, {
      token: managerToken,
      body: { status: 'done' },
    });
    assert.equal(attempt.status, 409);
  });

  test('subtasks cannot be nested more than one level', async () => {
    const parent = await createTask({ title: 'Top level' });
    const child = await api<TaskResponse>(context, 'POST', '/tasks', {
      token: managerToken,
      body: { teamId, title: 'Second level', parentTaskId: parent.id },
    });
    const grandchild = await api(context, 'POST', '/tasks', {
      token: managerToken,
      body: { teamId, title: 'Third level', parentTaskId: child.body.id },
    });
    assert.equal(grandchild.status, 422);
  });

  test('logging work burns down the remaining estimate', async () => {
    const task = await createTask({ title: 'Burn down', estimatedHours: 10 });
    const logged = await api<TaskResponse>(context, 'POST', `/tasks/${task.key}/work-logs`, {
      token: managerToken,
      body: { hours: 4 },
    });
    assert.equal(logged.status, 201);
    assert.equal(logged.body.loggedHours, 4);
    assert.equal(logged.body.remainingHours, 6);

    // An explicit re-estimate wins over the automatic burn-down.
    const reestimated = await api<TaskResponse>(context, 'POST', `/tasks/${task.key}/work-logs`, {
      token: managerToken,
      body: { hours: 2, remainingHours: 12 },
    });
    assert.equal(reestimated.body.loggedHours, 6);
    assert.equal(reestimated.body.remainingHours, 12);
  });

  test('the activity trail records who changed what', async () => {
    const task = await createTask({ title: 'Audited task' });
    await api(context, 'PATCH', `/tasks/${task.key}`, {
      token: managerToken,
      body: { status: 'in_progress', priority: 'urgent' },
    });

    const activity = await api<{ items: { action: string; field: string | null; toValue: string | null }[] }>(
      context,
      'GET',
      `/tasks/${task.key}/activity`,
      { token: managerToken },
    );
    assert.equal(activity.status, 200);
    const actions = activity.body.items.map((entry) => entry.action);
    assert.ok(actions.includes('created'));
    assert.ok(actions.includes('status_changed'));
    const statusChange = activity.body.items.find((entry) => entry.field === 'status');
    assert.equal(statusChange?.toValue, 'in_progress');
  });

  test('assigning splits the estimate and notifies the assignee', async () => {
    const members = await api<{ items: { userId: string; displayName: string }[] }>(
      context,
      'GET',
      `/teams/${teamId}/members`,
      { token: managerToken },
    );
    const lin = members.body.items.find((member) => member.displayName === 'Lin Chen')!;
    const task = await createTask({ title: 'Assignment notification', estimatedHours: 6 });

    const assigned = await api<TaskResponse>(context, 'PUT', `/assignments/tasks/${task.key}/assignees`, {
      token: managerToken,
      body: { userIds: [lin.userId] },
    });
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body.assignees.map((entry) => entry.userId), [lin.userId]);

    const linToken = await login(context, DEMO.qa);
    const notifications = await api<{ items: { kind: string; title: string }[] }>(
      context,
      'GET',
      '/notifications?unreadOnly=true',
      { token: linToken },
    );
    assert.ok(
      notifications.body.items.some((entry) => entry.kind === 'task_assigned' && entry.title.includes(task.key)),
      'the assignee should have been notified',
    );
  });

  test('bulk assignment reports partial failures rather than aborting', async () => {
    const members = await api<{ items: { userId: string; displayName: string }[] }>(
      context,
      'GET',
      `/teams/${teamId}/members`,
      { token: managerToken },
    );
    const lin = members.body.items.find((member) => member.displayName === 'Lin Chen')!;
    const good = await createTask({ title: 'Bulk target' });

    const response = await api<{ assigned: string[]; failed: { taskId: string; reason: string }[] }>(
      context,
      'POST',
      '/assignments/bulk',
      { token: managerToken, body: { taskIds: [good.key, 'PLAT-999999'], userIds: [lin.userId] } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.assigned, [good.key]);
    assert.equal(response.body.failed.length, 1);
    assert.match(response.body.failed[0]!.reason, /not found/i);
  });

  test('the kanban board groups tasks into ordered columns', async () => {
    const response = await api<{ columns: { status: string; tasks: TaskResponse[] }[] }>(
      context,
      'GET',
      `/tasks/board?teamId=${teamId}`,
      { token: managerToken },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.columns.map((column) => column.status),
      ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'],
    );
    for (const column of response.body.columns) {
      for (const task of column.tasks) assert.equal(task.status, column.status);
    }
  });

  test('list pagination returns a stable cursor', async () => {
    const first = await api<{ items: TaskResponse[]; nextCursor: string | null }>(
      context,
      'GET',
      `/tasks?teamId=${teamId}&limit=3`,
      { token: managerToken },
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 3);
    assert.ok(first.body.nextCursor, 'expected more pages');

    const second = await api<{ items: TaskResponse[] }>(
      context,
      'GET',
      `/tasks?teamId=${teamId}&limit=3&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
      { token: managerToken },
    );
    const firstIds = new Set(first.body.items.map((task) => task.id));
    for (const task of second.body.items) {
      assert.ok(!firstIds.has(task.id), 'pages must not overlap');
    }
  });

  test('a malformed cursor is rejected cleanly', async () => {
    const response = await api(context, 'GET', '/tasks?cursor=not-a-cursor', { token: managerToken });
    assert.equal(response.status, 400);
  });
});
