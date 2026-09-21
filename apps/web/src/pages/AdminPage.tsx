import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_PERMISSIONS, type PublicUser, type Role } from '@teamspace/shared';
import { api, ApiError, qs } from '../api/client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBlock,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  formatRelativeTime,
} from '../components/ui';
import { useToast } from '../state/ToastContext';

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface RetentionPolicy {
  scope: string;
  retentionDays: number;
  enforced: boolean;
  updatedAt: string;
}

type Tab = 'users' | 'audit' | 'retention' | 'permissions';

export function AdminPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <>
      <PageHeader title="Administration" subtitle="Users, roles, retention and the audit trail." />

      <div className="row row--wrap" style={{ marginBottom: 'var(--space-4)' }}>
        {(['users', 'audit', 'retention', 'permissions'] as Tab[]).map((entry) => (
          <Button
            key={entry}
            variant={entry === tab ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab(entry)}
            aria-pressed={entry === tab}
            style={{ textTransform: 'capitalize' }}
          >
            {entry}
          </Button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'retention' && <RetentionTab />}
      {tab === 'permissions' && <PermissionsTab />}
    </>
  );
}

function UsersTab(): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [search, setSearch] = useState('');

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['users', 'admin', search],
    queryFn: () =>
      api.get<{ items: PublicUser[] }>(`/users${qs({ search: search || undefined, includeInactive: true, limit: 200 })}`).then((r) => r.items),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.patch(`/users/${userId}`, { role }),
    onSuccess: () => {
      notify('Role updated — that user must sign in again', 'success');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not change the role', 'error'),
  });

  const setActive = useMutation({
    mutationFn: ({ userId, isActive }: { userId: string; isActive: boolean }) =>
      api.patch(`/users/${userId}`, { isActive }),
    onSuccess: () => {
      notify('Account updated', 'success');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not update the account', 'error'),
  });

  if (isPending) return <LoadingBlock rows={5} label="Loading users" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card flush>
      <div className="card__header">
        <label className="sr-only" htmlFor="user-search">
          Search users
        </label>
        <Input
          id="user-search"
          type="search"
          placeholder="Search by name or email…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <table className="table">
        <caption className="sr-only">Users in this organization</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col" className="th--numeric">Weekly capacity</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {data.map((person) => (
            <tr key={person.id}>
              <th scope="row" style={{ fontWeight: 500 }}>
                {person.displayName}
                <br />
                <span className="tiny">{person.jobTitle ?? '—'}</span>
              </th>
              <td className="tiny">{person.email}</td>
              <td>
                <label className="sr-only" htmlFor={`role-${person.id}`}>
                  Role for {person.displayName}
                </label>
                <Select
                  id={`role-${person.id}`}
                  value={person.role}
                  onChange={(event) => changeRole.mutate({ userId: person.id, role: event.target.value as Role })}
                  style={{ width: 'auto' }}
                >
                  <option value="member">member</option>
                  <option value="manager">manager</option>
                  <option value="admin">admin</option>
                </Select>
              </td>
              <td>
                <Badge tone={person.isActive ? 'healthy' : 'overloaded'}>
                  {person.isActive ? 'active' : 'deactivated'}
                </Badge>
              </td>
              <td className="td--numeric numeric">{person.weeklyCapacityHours}h</td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setActive.mutate({ userId: person.id, isActive: !person.isActive })}
                >
                  {person.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function AuditTab(): JSX.Element {
  const [action, setAction] = useState('');
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['audit', action],
    queryFn: () => api.get<{ items: AuditEntry[] }>(`/admin/audit-logs${qs({ action: action || undefined, limit: 100 })}`).then((r) => r.items),
  });

  if (isPending) return <LoadingBlock rows={5} label="Loading the audit trail" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card flush>
      <div className="card__header">
        <label className="sr-only" htmlFor="audit-filter">
          Filter by action
        </label>
        <Input
          id="audit-filter"
          type="search"
          placeholder="Filter by action prefix, e.g. auth. or task."
          value={action}
          onChange={(event) => setAction(event.target.value)}
        />
      </div>

      {data.length === 0 ? (
        <EmptyState icon="⚙" title="No matching entries" />
      ) : (
        <table className="table">
          <caption className="sr-only">Audit log entries</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">IP</th>
            </tr>
          </thead>
          <tbody>
            {data.map((entry) => (
              <tr key={entry.id}>
                <td className="tiny">{formatRelativeTime(entry.createdAt)}</td>
                <td>{entry.actorName ?? 'System'}</td>
                <td>
                  <code style={{ fontSize: 'var(--text-xs)' }}>{entry.action}</code>
                </td>
                <td className="tiny">
                  {entry.entityType}
                  {entry.entityId ? ` · ${entry.entityId.slice(0, 8)}` : ''}
                </td>
                <td className="tiny">{entry.ipAddress ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function RetentionTab(): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['retention'],
    queryFn: () => api.get<{ items: RetentionPolicy[] }>('/admin/retention-policies').then((r) => r.items),
  });

  const update = useMutation({
    mutationFn: (policy: { scope: string; retentionDays: number; enforced: boolean }) =>
      api.put('/admin/retention-policies', policy),
    onSuccess: () => {
      notify('Retention policy saved', 'success');
      void queryClient.invalidateQueries({ queryKey: ['retention'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not save', 'error'),
  });

  if (isPending) return <LoadingBlock rows={4} label="Loading retention policies" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card title="Retention policies">
      <p className="muted" style={{ marginBottom: 'var(--space-4)' }}>
        Conversation history is kept for 365 days by default. Messages are stored in monthly partitions, so an
        expired month is dropped outright rather than deleted row by row.
      </p>

      <table className="table">
        <caption className="sr-only">Retention policy per data class</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col" className="th--numeric">Days retained</th>
            <th scope="col">Enforced</th>
            <th scope="col">Last changed</th>
          </tr>
        </thead>
        <tbody>
          {data.map((policy) => (
            <tr key={policy.scope}>
              <th scope="row" style={{ fontWeight: 500, textTransform: 'capitalize' }}>
                {policy.scope.replace('_', ' ')}
              </th>
              <td className="td--numeric">
                <label className="sr-only" htmlFor={`retention-${policy.scope}`}>
                  Days to retain {policy.scope}
                </label>
                <Input
                  id={`retention-${policy.scope}`}
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={policy.retentionDays}
                  style={{ width: 110, textAlign: 'right' }}
                  onBlur={(event) => {
                    const days = Number(event.target.value);
                    if (days !== policy.retentionDays) {
                      update.mutate({ scope: policy.scope, retentionDays: days, enforced: policy.enforced });
                    }
                  }}
                />
              </td>
              <td>
                <label className="row" style={{ gap: 'var(--space-2)' }}>
                  <input
                    type="checkbox"
                    checked={policy.enforced}
                    onChange={(event) =>
                      update.mutate({
                        scope: policy.scope,
                        retentionDays: policy.retentionDays,
                        enforced: event.target.checked,
                      })
                    }
                  />
                  <span className="tiny">{policy.enforced ? 'Purging' : 'Dry run only'}</span>
                </label>
              </td>
              <td className="tiny">{formatRelativeTime(policy.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Renders the shared permission matrix rather than duplicating it here. */
function PermissionsTab(): JSX.Element {
  const roles: Role[] = ['member', 'manager', 'admin'];
  const permissions = [...new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]))].sort();

  return (
    <Card title="Role and permission matrix" flush>
      <table className="table">
        <caption className="sr-only">Which permissions each role holds</caption>
        <thead>
          <tr>
            <th scope="col">Permission</th>
            {roles.map((role) => (
              <th key={role} scope="col" style={{ textTransform: 'capitalize' }}>
                {role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {permissions.map((permission) => (
            <tr key={permission}>
              <th scope="row" style={{ fontWeight: 400 }}>
                <code style={{ fontSize: 'var(--text-xs)' }}>{permission}</code>
              </th>
              {roles.map((role) => {
                const granted = ROLE_PERMISSIONS[role].includes(permission);
                return (
                  <td key={role}>
                    <span aria-hidden="true" style={{ color: granted ? 'var(--band-healthy)' : 'var(--text-muted)' }}>
                      {granted ? '●' : '—'}
                    </span>
                    <span className="sr-only">{granted ? 'granted' : 'not granted'}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
