import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Boots the real Express app against a real PostgreSQL database. Nothing is
 * mocked: these tests exercise the SQL, the constraints and the RBAC scope
 * checks exactly as production does.
 *
 * Set TEST_DATABASE_URL to run them; without it the suites skip rather than
 * fail, so `npm test` stays green on a machine with no database.
 */
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const canRunIntegrationTests = Boolean(DATABASE_URL);

export interface TestContext {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestContext> {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ??= 'integration-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'integration-refresh-secret-0123456789';

  const { createApp } = await import('../../src/app.ts');
  const { seed } = await import('../../src/db/seed.ts');
  const { closePool } = await import('../../src/db/pool.ts');

  await seed();

  const app = createApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closePool();
    },
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  context: TestContext,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${context.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

export async function login(context: TestContext, email: string): Promise<string> {
  const response = await api<{ accessToken: string }>(context, 'POST', '/auth/login', {
    body: { email, password: 'TeamSpace!2026' },
  });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${JSON.stringify(response.body)}`);
  }
  return response.body.accessToken;
}

export const DEMO = {
  admin: 'admin@teamspace.dev',
  manager: 'maya@teamspace.dev',
  frontend: 'sam@teamspace.dev',
  backend: 'priya@teamspace.dev',
  qa: 'lin@teamspace.dev',
} as const;
