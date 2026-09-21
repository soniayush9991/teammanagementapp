import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

interface SearchHitResponse {
  type: string;
  title: string;
  snippet: string;
  link: string;
  rank: number;
}

describe('search, reports and retention', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let managerToken: string;
  let memberToken: string;
  let teamId: string;

  before(async () => {
    context = await startTestServer();
    managerToken = await login(context, DEMO.manager);
    memberToken = await login(context, DEMO.frontend);
    const teams = await api<{ items: { id: string; name: string }[] }>(context, 'GET', '/teams', {
      token: managerToken,
    });
    teamId = teams.body.items.find((team) => team.name === 'Platform')!.id;
  });

  after(async () => context?.close());

  test('search spans tasks and messages and ranks results', async () => {
    const response = await api<{ items: SearchHitResponse[] }>(context, 'GET', '/search?q=retention', {
      token: managerToken,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.items.length > 0);

    const types = new Set(response.body.items.map((hit) => hit.type));
    assert.ok(types.has('task'), 'expected task hits');
    for (let index = 1; index < response.body.items.length; index += 1) {
      assert.ok(response.body.items[index - 1]!.rank >= response.body.items[index]!.rank);
    }
  });

  test('results carry a highlighted snippet and a deep link', async () => {
    const response = await api<{ items: SearchHitResponse[] }>(context, 'GET', '/search?q=partition&types=task', {
      token: managerToken,
    });
    const hit = response.body.items[0];
    assert.ok(hit, 'expected at least one hit');
    assert.match(hit.link, /^\/tasks\/PLAT-\d+$/);
    assert.ok(hit.snippet.includes('<mark>'), 'expected the matched term to be highlighted');
  });

  test('message snippets render mentions as plain text', async () => {
    const conversations = await api<{ items: { id: string; name: string | null }[] }>(
      context,
      'GET',
      '/conversations',
      { token: managerToken },
    );
    const channelId = conversations.body.items.find((entry) => entry.name === 'platform-standup')!.id;
    const me = await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token: managerToken });

    await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: `Zephyrquux protocol owner is @[Maya Okonkwo](${me.body.actor.id}).` },
    });

    const response = await api<{ items: SearchHitResponse[] }>(
      context,
      'GET',
      '/search?q=zephyrquux&types=message',
      { token: managerToken },
    );
    const hit = response.body.items[0];
    assert.ok(hit, 'expected the message to be indexed and found');
    assert.ok(!hit.snippet.includes(']('), 'mention markup must not leak into the snippet');
  });

  test('search never returns content the caller cannot access', async () => {
    // Sam is not on the Platform team, so Platform tasks must not surface.
    const response = await api<{ items: SearchHitResponse[] }>(context, 'GET', '/search?q=partition', {
      token: memberToken,
    });
    assert.equal(response.status, 200);
    for (const hit of response.body.items) {
      assert.ok(!hit.link.startsWith('/tasks/PLAT-'), `leaked a Platform task: ${hit.title}`);
    }
  });

  test('quoted phrases and exclusions are accepted rather than erroring', async () => {
    const phrase = await api<{ items: SearchHitResponse[] }>(
      context,
      'GET',
      `/search?q=${encodeURIComponent('"full-text search"')}&types=task`,
      { token: managerToken },
    );
    assert.equal(phrase.status, 200);

    // A query with punctuation that would break to_tsquery must not 500.
    const messy = await api(context, 'GET', `/search?q=${encodeURIComponent('search -index (draft)')}`, {
      token: managerToken,
    });
    assert.equal(messy.status, 200);
  });

  test('typeahead suggests people and tasks', async () => {
    const response = await api<{ users: { displayName: string }[]; tasks: { key: string }[] }>(
      context,
      'GET',
      '/search/suggest?q=pri',
      { token: managerToken },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body.users.some((user) => user.displayName === 'Priya Nair'));
  });

  test('the workload report agrees with the capacity endpoint', async () => {
    const [report, capacity] = await Promise.all([
      api<{ rows: { userId: string; plannedHours: number; band: string }[] }>(
        context,
        'GET',
        `/reports/workload?teamId=${teamId}`,
        { token: managerToken },
      ),
      api<{ members: { userId: string; capacity: { plannedHours: number; band: string } }[] }>(
        context,
        'GET',
        `/capacity/teams/${teamId}`,
        { token: managerToken },
      ),
    ]);

    assert.equal(report.status, 200);
    for (const row of report.body.rows) {
      const member = capacity.body.members.find((entry) => entry.userId === row.userId)!;
      assert.equal(row.plannedHours, member.capacity.plannedHours);
      assert.equal(row.band, member.capacity.band);
    }
  });

  test('the overdue report lists only genuinely late open work', async () => {
    const response = await api<{ rows: { taskKey: string; daysOverdue: number; status: string }[] }>(
      context,
      'GET',
      `/reports/overdue?teamId=${teamId}`,
      { token: managerToken },
    );
    assert.equal(response.status, 200);
    for (const row of response.body.rows) {
      assert.ok(row.daysOverdue > 0, `${row.taskKey} is not actually overdue`);
      assert.ok(!['done', 'cancelled'].includes(row.status));
    }
  });

  test('the completion trend returns a gapless date series', async () => {
    const response = await api<{ rows: { day: string; completedCount: number }[] }>(
      context,
      'GET',
      `/reports/completion-trend?teamId=${teamId}&from=2026-09-01&to=2026-09-10`,
      { token: managerToken },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 10, 'every day in the range must appear');
    assert.equal(response.body.rows[0]!.day, '2026-09-01');
    assert.equal(response.body.rows.at(-1)!.day, '2026-09-10');
  });

  test('CSV export is downloadable, escaped and BOM-prefixed', async () => {
    const response = await fetch(
      `${context.baseUrl}/reports/workload/export?teamId=${teamId}&format=csv`,
      { headers: { authorization: `Bearer ${managerToken}` } },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="workload-.*\.csv"/);

    // Read raw bytes: fetch's text() strips a UTF-8 BOM, which is exactly the
    // byte Excel needs, so the assertion has to look at the buffer itself.
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'expected a UTF-8 BOM');
    const text = bytes.toString('utf8');
    assert.ok(text.includes('Employee,Role,Capacity (h)'));
    assert.ok(text.includes('\r\n'));
  });

  test('PDF export returns a real PDF', async () => {
    const response = await fetch(
      `${context.baseUrl}/reports/overdue/export?teamId=${teamId}&format=pdf`,
      { headers: { authorization: `Bearer ${managerToken}` } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.toString('latin1').trimEnd().endsWith('%%EOF'));
  });

  test('an unknown report name is rejected with the valid options', async () => {
    const response = await api<{ error: { details: { known: string[] } } }>(
      context,
      'GET',
      `/reports/not-a-report/export?teamId=${teamId}`,
      { token: managerToken },
    );
    assert.equal(response.status, 400);
    assert.ok(response.body.error.details.known.includes('workload'));
  });

  test('retention keeps recent conversation history and provisions partitions', async () => {
    const { runRetention } = await import('../../src/jobs/retention.ts');
    const { queryOne } = await import('../../src/db/pool.ts');

    const before = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM messages');
    const result = await runRetention();

    const after = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM messages');
    // Everything in the seed is well inside the 365-day window.
    assert.equal(after?.count, before?.count, 'recent messages must be retained');
    assert.ok(result.partitionsCreated.length >= 1, 'future partitions should be provisioned');
    assert.equal(result.partitionsDropped.length, 0, 'nothing is old enough to drop');
  });

  test('retention drops a partition once its whole month is out of the window', async () => {
    const { runRetention } = await import('../../src/jobs/retention.ts');
    const { query, queryOne } = await import('../../src/db/pool.ts');

    // Plant a message two years back, in its own monthly partition.
    const old = new Date();
    old.setUTCFullYear(old.getUTCFullYear() - 2);
    const day = old.toISOString().slice(0, 10);
    await query('SELECT ensure_message_partition($1::date)', [day]);

    const conversation = await queryOne<{ id: string }>(
      `SELECT id FROM conversations WHERE name = 'general' LIMIT 1`,
    );
    await query(
      `INSERT INTO messages (conversation_id, body, created_at) VALUES ($1, 'ancient history', $2)`,
      [conversation?.id, old.toISOString()],
    );

    const planted = await queryOne<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE body = $1',
      ['ancient history'],
    );
    assert.equal(planted?.count, '1');

    const result = await runRetention();
    assert.ok(result.partitionsDropped.length >= 1, 'the expired partition should have been dropped');

    const remaining = await queryOne<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE body = $1',
      ['ancient history'],
    );
    assert.equal(remaining?.count, '0', 'expired history must be gone');
  });
});
