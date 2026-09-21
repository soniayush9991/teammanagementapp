import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, canRunIntegrationTests, DEMO, startTestServer, type TestContext } from './harness.ts';

/** Signs in with raw fetch so the refresh cookie can be inspected directly. */
async function loginRaw(context: TestContext, email: string): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch(`${context.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'TeamSpace!2026' }),
  });
  const body = (await response.json()) as { accessToken: string };
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('teamspace_rt='));
  assert.ok(cookie, 'expected a refresh cookie');
  return { accessToken: body.accessToken, refreshToken: cookie.split(';')[0]!.split('=')[1]! };
}

async function refreshWith(
  context: TestContext,
  refreshToken: string,
): Promise<{ status: number; accessToken?: string; newRefreshToken?: string; code?: string }> {
  const response = await fetch(`${context.baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const body = (await response.json()) as { accessToken?: string; error?: { code: string } };
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('teamspace_rt='));
  return {
    status: response.status,
    accessToken: body.accessToken,
    newRefreshToken: cookie ? cookie.split(';')[0]!.split('=')[1]! : undefined,
    code: body.error?.code,
  };
}

describe('authentication', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;

  before(async () => {
    context = await startTestServer();
  });

  after(async () => context?.close());

  test('a wrong password and an unknown account fail identically', async () => {
    const wrongPassword = await api<{ error: { message: string } }>(context, 'POST', '/auth/login', {
      body: { email: DEMO.manager, password: 'not-the-password' },
    });
    const unknownAccount = await api<{ error: { message: string } }>(context, 'POST', '/auth/login', {
      body: { email: 'nobody@teamspace.dev', password: 'not-the-password' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    // Identical wording, so the endpoint cannot be used to enumerate accounts.
    assert.equal(wrongPassword.body.error.message, unknownAccount.body.error.message);
  });

  test('signing in issues an access token and an httpOnly refresh cookie', async () => {
    const response = await fetch(`${context.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO.manager, password: 'TeamSpace!2026' }),
    });
    assert.equal(response.status, 200);

    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('teamspace_rt='));
    assert.ok(cookie, 'expected the refresh cookie');
    assert.match(cookie, /HttpOnly/i, 'the refresh cookie must not be readable by JavaScript');
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api\/v1\/auth/i, 'the cookie should only be sent to auth endpoints');

    const body = (await response.json()) as { accessToken: string; permissions: string[] };
    assert.ok(body.accessToken.split('.').length === 3, 'access token should be a JWT');
    assert.ok(body.permissions.includes('capacity:read_team'));
  });

  test('refreshing rotates the token', async () => {
    const { refreshToken } = await loginRaw(context, DEMO.frontend);
    const rotated = await refreshWith(context, refreshToken);

    assert.equal(rotated.status, 200);
    assert.ok(rotated.newRefreshToken, 'a rotated token should be set');
    assert.notEqual(rotated.newRefreshToken, refreshToken, 'the token must change on every use');
  });

  test('a racing double refresh is tolerated rather than treated as theft', async () => {
    // Two tabs, or React StrictMode, can fire the same refresh twice before
    // either response lands. That must not log the user out.
    const { refreshToken } = await loginRaw(context, DEMO.qa);

    const [first, second] = await Promise.all([
      refreshWith(context, refreshToken),
      refreshWith(context, refreshToken),
    ]);

    assert.equal(first.status, 200, 'the first refresh should succeed');
    assert.equal(second.status, 200, 'the racing refresh should also succeed');

    // Exactly one of them rotated the cookie; the other left it alone.
    const rotations = [first.newRefreshToken, second.newRefreshToken].filter(Boolean);
    assert.equal(rotations.length, 1, 'only one response should set a new cookie');

    // The session still works afterwards.
    const whoami = await api(context, 'GET', '/whoami', { token: first.accessToken! });
    assert.equal(whoami.status, 200);
  });

  test('replaying an old token after the grace window revokes every session', async () => {
    const { queryOne, query } = await import('../../src/db/pool.ts');
    const { refreshToken } = await loginRaw(context, DEMO.backend);

    const rotated = await refreshWith(context, refreshToken);
    assert.equal(rotated.status, 200);
    const currentToken = rotated.newRefreshToken!;

    // Age the rotation past the grace window, as a real thief replaying a
    // stolen token days later would be.
    const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [DEMO.backend]);
    await query(
      `UPDATE refresh_tokens SET revoked_at = now() - INTERVAL '1 hour'
        WHERE user_id = $1 AND revoked_at IS NOT NULL`,
      [user?.id],
    );

    const replay = await refreshWith(context, refreshToken);
    assert.equal(replay.status, 401, 'a stale replay must be rejected');

    // And the token family is gone, so the thief's newer token is dead too.
    const afterwards = await refreshWith(context, currentToken);
    assert.equal(afterwards.status, 401, 'the whole family should be revoked');

    const audit = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'auth.refresh_reuse_detected' AND actor_id = $1`,
      [user?.id],
    );
    assert.ok(Number(audit?.count ?? 0) > 0, 'the detection should be audited');
  });

  test('signing out revokes the presented token', async () => {
    const { refreshToken } = await loginRaw(context, DEMO.manager);
    const response = await fetch(`${context.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `teamspace_rt=${refreshToken}` },
    });
    assert.equal(response.status, 204);

    const afterwards = await refreshWith(context, refreshToken);
    assert.equal(afterwards.status, 401);
  });

  test('changing a password ends every other session', async () => {
    const { accessToken, refreshToken } = await loginRaw(context, DEMO.frontend);

    const changed = await api(context, 'POST', '/auth/change-password', {
      token: accessToken,
      body: { currentPassword: 'TeamSpace!2026', newPassword: 'An0ther!Passphrase' },
    });
    assert.equal(changed.status, 204);

    assert.equal((await refreshWith(context, refreshToken)).status, 401);

    // Restore the seeded password so the suite stays re-runnable.
    const reLogin = await fetch(`${context.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO.frontend, password: 'An0ther!Passphrase' }),
    });
    const body = (await reLogin.json()) as { accessToken: string };
    await api(context, 'POST', '/auth/change-password', {
      token: body.accessToken,
      body: { currentPassword: 'An0ther!Passphrase', newPassword: 'TeamSpace!2026' },
    });
  });

  test('a weak password is refused', async () => {
    const { accessToken } = await loginRaw(context, DEMO.manager);
    const response = await api(context, 'POST', '/auth/change-password', {
      token: accessToken,
      body: { currentPassword: 'TeamSpace!2026', newPassword: 'alllowercaseletters' },
    });
    assert.equal(response.status, 422);
  });
});
