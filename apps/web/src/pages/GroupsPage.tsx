import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Conversation, PublicUser } from '@teamspace/shared';
import { api, ApiError } from '../api/client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBlock,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
} from '../components/ui';
import { useToast } from '../state/ToastContext';
import { useAuth } from '../state/AuthContext';

interface ConversationMember {
  userId: string;
  displayName: string;
  role: string;
}

export function GroupsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<Conversation | null>(null);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['conversations', 'groups'],
    queryFn: () =>
      api
        .get<{ items: Conversation[] }>('/conversations?includePublic=true&limit=100')
        .then((response) => response.items.filter((conversation) => conversation.kind !== 'dm')),
  });

  const join = useMutation({
    mutationFn: (conversationId: string) => api.post(`/conversations/${conversationId}/join`),
    onSuccess: () => {
      notify('Joined', 'success');
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not join', 'error'),
  });

  const leave = useMutation({
    mutationFn: (conversationId: string) => api.post(`/conversations/${conversationId}/leave`),
    onSuccess: () => {
      notify('Left the group', 'success');
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not leave', 'error'),
  });

  if (isPending) return <LoadingBlock rows={4} label="Loading groups" />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title="Groups and channels"
        subtitle="Public channels are open to everyone; private groups are invite only."
        actions={<Button onClick={() => setCreating(true)}>New group</Button>}
      />

      {data.length === 0 ? (
        <EmptyState icon="◍" title="No groups yet" description="Create one to get a conversation started." />
      ) : (
        <div className="grid grid--halves">
          {data.map((conversation) => (
            <Card
              key={conversation.id}
              title={
                <span className="row">
                  <strong>
                    {conversation.kind === 'channel' ? '#' : '◍'} {conversation.name}
                  </strong>
                  <Badge tone={conversation.visibility === 'public' ? 'healthy' : undefined}>
                    {conversation.visibility}
                  </Badge>
                </span>
              }
              actions={
                <Button variant="ghost" size="sm" onClick={() => navigate(`/chat/${conversation.id}`)}>
                  Open
                </Button>
              }
            >
              <p className="muted">{conversation.topic ?? 'No topic set.'}</p>
              <div className="row row--between" style={{ marginTop: 'var(--space-3)' }}>
                <span className="tiny">{conversation.memberCount} members</span>
                <span className="row">
                  <Button variant="secondary" size="sm" onClick={() => setManaging(conversation)}>
                    Members
                  </Button>
                  {conversation.createdBy === user?.id ? (
                    <Badge tone="accent">Owner</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => join.mutate(conversation.id)}>
                      Join
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => leave.mutate(conversation.id)}>
                    Leave
                  </Button>
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
      {managing && <ManageMembersDialog conversation={managing} onClose={() => setManaging(null)} />}
    </>
  );
}

function CreateGroupDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<'group' | 'channel'>('group');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<Conversation>('/conversations', { kind, name: name.trim(), topic: topic.trim() || undefined, visibility }),
    onSuccess: () => {
      notify('Group created', 'success');
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onClose();
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'Could not create the group'),
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Give the group a name');
      return;
    }
    create.mutate();
  };

  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Name" htmlFor="group-name" error={error ?? undefined}>
          <Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={120} />
        </Field>
        <Field label="Topic" htmlFor="group-topic" hint="One line on what this group is for.">
          <Input id="group-topic" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={500} />
        </Field>
        <Field label="Type" htmlFor="group-kind" hint={can('conversation:create_channel') ? undefined : 'Only managers can create team channels.'}>
          <Select
            id="group-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'group' | 'channel')}
            disabled={!can('conversation:create_channel')}
          >
            <option value="group">Group — a focused, usually private space</option>
            <option value="channel">Channel — a team-wide space</option>
          </Select>
        </Field>
        <Field label="Visibility" htmlFor="group-visibility">
          <Select
            id="group-visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as 'private' | 'public')}
          >
            <option value="private">Private — invite only</option>
            <option value="public">Public — anyone in the organization can join</option>
          </Select>
        </Field>
      </form>
    </Modal>
  );
}

function ManageMembersDialog({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [selected, setSelected] = useState('');

  const membersQuery = useQuery({
    queryKey: ['conversations', conversation.id, 'members'],
    queryFn: () =>
      api.get<{ items: ConversationMember[] }>(`/conversations/${conversation.id}/members`).then((r) => r.items),
  });

  const directoryQuery = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => api.get<{ items: PublicUser[] }>('/users?limit=200').then((r) => r.items),
  });

  const invite = useMutation({
    mutationFn: (userId: string) => api.post(`/conversations/${conversation.id}/members`, { userIds: [userId] }),
    onSuccess: () => {
      notify('Invitation sent', 'success');
      setSelected('');
      void queryClient.invalidateQueries({ queryKey: ['conversations', conversation.id, 'members'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not invite', 'error'),
  });

  const promote = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.put(`/conversations/${conversation.id}/members/${userId}/role`, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', conversation.id, 'members'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not change the role', 'error'),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/conversations/${conversation.id}/members/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', conversation.id, 'members'] });
    },
    onError: (caught) => notify(caught instanceof ApiError ? caught.message : 'Could not remove', 'error'),
  });

  const members = membersQuery.data ?? [];
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = (directoryQuery.data ?? []).filter((person) => !memberIds.has(person.id));

  return (
    <Modal title={`Members of ${conversation.name ?? 'this group'}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
        <label className="sr-only" htmlFor="invite-user">
          Invite someone
        </label>
        <Select id="invite-user" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Choose someone to invite…</option>
          {candidates.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </Select>
        <Button disabled={!selected} onClick={() => invite.mutate(selected)}>
          Invite
        </Button>
      </div>

      {membersQuery.isPending ? (
        <LoadingBlock rows={3} label="Loading members" />
      ) : (
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {members.map((member) => (
            <li key={member.userId} className="row row--between">
              <span className="row">
                <Avatar name={member.displayName} size="sm" />
                {member.displayName}
                {member.role !== 'member' && <Badge tone="accent">{member.role}</Badge>}
              </span>
              <span className="row">
                {member.role === 'member' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => promote.mutate({ userId: member.userId, role: 'admin' })}
                  >
                    Make admin
                  </Button>
                )}
                {member.role !== 'owner' && (
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(member.userId)} aria-label={`Remove ${member.displayName}`}>
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
