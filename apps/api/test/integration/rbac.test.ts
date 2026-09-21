import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

describe('authorization boundaries', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let managerToken: string;
  let memberToken: string;
  let adminToken: string;
  let platformTeamId: string;
  let memberId: string;

  before(async () => {
    context = await startTestServer();
    managerToken = await login(context, DEMO.manager);
    memberToken = await login(context, DEMO.frontend);
    adminToken = await login(context, DEMO.admin);

    const teams = await api<{ items: { id: string; name: string }[] }>(context, 'GET', '/teams', {
      token: managerToken,
    });
    platformTeamId = teams.body.items.find((team) => team.name === 'Platform')!.id;

    const me = await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token: memberToken });
    memberId = me.body.actor.id;
  });

  after(async () => context?.close());

  test('an unauthenticated request is rejected', async () => {
    assert.equal((await api(context, 'GET', '/teams')).status, 401);
    assert.equal((await api(context, 'GET', '/tasks')).status, 401);
  });

  test('a forged bearer token is rejected', async () => {
    const response = await api(context, 'GET', '/teams', { token: 'not.a.real.token' });
    assert.equal(response.status, 401);
  });

  test('a member cannot read a team they do not belong to', async () => {
    // Sam is on Experience, not Platform.
    const capacity = await api(context, 'GET', `/capacity/teams/${platformTeamId}`, { token: memberToken });
    assert.equal(capacity.status, 403);

    const task = await api(context, 'GET', '/tasks/PLAT-1', { token: memberToken });
    assert.equal(task.status, 403);
  });

  test('a member cannot open the manager dashboard or team reports', async () => {
    assert.equal(
      (await api(context, 'GET', `/dashboard/manager?teamId=${platformTeamId}`, { token: memberToken })).status,
      403,
    );
    assert.equal(
      (await api(context, 'GET', `/reports/workload?teamId=${platformTeamId}`, { token: memberToken })).status,
      403,
    );
  });

  test('a member cannot escalate their own role', async () => {
    const response = await api(context, 'PATCH', `/users/${memberId}`, {
      token: memberToken,
      body: { role: 'admin' },
    });
    assert.equal(response.status, 403);

    const after = await api<{ role: string }>(context, 'GET', `/users/${memberId}`, { token: adminToken });
    assert.equal(after.body.role, 'member', 'role must be unchanged');
  });

  test('a manager cannot mint an admin', async () => {
    const response = await api(context, 'POST', '/users', {
      token: managerToken,
      body: {
        email: 'escalation@teamspace.dev',
        password: 'Str0ng!Passphrase',
        displayName: 'Escalation Attempt',
        role: 'admin',
      },
    });
    assert.equal(response.status, 403);
  });

  test('a member cannot read the audit trail', async () => {
    assert.equal((await api(context, 'GET', '/admin/audit-logs', { token: memberToken })).status, 403);
    assert.equal((await api(context, 'GET', '/admin/audit-logs', { token: adminToken })).status, 200);
  });

  test('a member can still do their own work', async () => {
    assert.equal((await api(context, 'GET', '/dashboard/me', { token: memberToken })).status, 200);
    assert.equal((await api(context, 'GET', '/capacity/me', { token: memberToken })).status, 200);
    assert.equal((await api(context, 'GET', '/notifications', { token: memberToken })).status, 200);
  });

  test('nobody, not even an admin, can read a DM they are not part of', async () => {
    const conversations = await api<{ items: { id: string; kind: string }[] }>(
      context,
      'GET',
      '/conversations?kind=dm',
      { token: managerToken },
    );
    const dmId = conversations.body.items[0]?.id;
    assert.ok(dmId, 'expected the seeded DM');

    assert.equal((await api(context, 'GET', `/conversations/${dmId}/messages`, { token: adminToken })).status, 403);
    assert.equal((await api(context, 'GET', `/conversations/${dmId}/messages`, { token: managerToken })).status, 200);
  });

  test('a member cannot assign work to someone else', async () => {
    const tasks = await api<{ items: { id: string; key: string }[] }>(context, 'GET', '/tasks?teamId=' + platformTeamId, {
      token: managerToken,
    });
    const taskKey = tasks.body.items[0]?.key;
    assert.ok(taskKey);

    const response = await api(context, 'PUT', `/assignments/tasks/${taskKey}/assignees`, {
      token: memberToken,
      body: { userIds: [memberId] },
    });
    // Sam cannot even see this Platform task, let alone reassign it.
    assert.equal(response.status, 403);
  });
});
