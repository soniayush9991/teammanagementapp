import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, canRunIntegrationTests, DEMO, login, startTestServer, type TestContext } from './harness.ts';

interface MessageResponse {
  id: string;
  body: string;
  mentions: string[];
  replyCount: number;
  isPinned: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: { emoji: string; count: number; userIds: string[] }[];
}

interface ConversationResponse {
  id: string;
  kind: string;
  name: string | null;
  unreadCount: number;
  memberCount: number;
}

describe('messaging and collaboration', { skip: canRunIntegrationTests ? false : 'TEST_DATABASE_URL not set' }, () => {
  let context: TestContext;
  let managerToken: string;
  let memberToken: string;
  let memberId: string;
  let channelId: string;

  before(async () => {
    context = await startTestServer();
    managerToken = await login(context, DEMO.manager);
    memberToken = await login(context, DEMO.backend);

    const me = await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token: memberToken });
    memberId = me.body.actor.id;

    const conversations = await api<{ items: ConversationResponse[] }>(context, 'GET', '/conversations', {
      token: managerToken,
    });
    channelId = conversations.body.items.find((entry) => entry.name === 'platform-standup')!.id;
  });

  after(async () => context?.close());

  test('sending a message returns it fully hydrated', async () => {
    const response = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'Deploy window is 14:00 UTC.' },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.body, 'Deploy window is 14:00 UTC.');
    assert.deepEqual(response.body.reactions, []);
    assert.equal(response.body.replyCount, 0);
  });

  test('a mention notifies exactly the mentioned person', async () => {
    const before = await api<{ unreadCount: number }>(context, 'GET', '/notifications?unreadOnly=true', {
      token: memberToken,
    });

    await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: `Question for @[Priya Nair](${memberId}) about the index plan.` },
    });

    const after = await api<{ unreadCount: number; items: { kind: string }[] }>(
      context,
      'GET',
      '/notifications?unreadOnly=true',
      { token: memberToken },
    );
    assert.equal(after.body.unreadCount, before.body.unreadCount + 1);
    assert.equal(after.body.items[0]?.kind, 'mention');
  });

  test('mentioning someone outside the conversation does not leak the message to them', async () => {
    const outsider = await login(context, DEMO.frontend); // Sam is not in platform-standup
    const outsiderId = (await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token: outsider })).body
      .actor.id;
    const before = await api<{ unreadCount: number }>(context, 'GET', '/notifications?unreadOnly=true', {
      token: outsider,
    });

    const sent = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: `Stray mention of @[Sam Rivera](${outsiderId}).` },
    });
    assert.equal(sent.status, 201);
    assert.deepEqual(sent.body.mentions, [], 'a non-member must not be resolved as a mention');

    const after = await api<{ unreadCount: number }>(context, 'GET', '/notifications?unreadOnly=true', {
      token: outsider,
    });
    assert.equal(after.body.unreadCount, before.body.unreadCount);
  });

  test('threaded replies are counted on the parent, not the root list', async () => {
    const root = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'Thread root' },
    });
    await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: memberToken,
      body: { body: 'First reply', parentMessageId: root.body.id },
    });
    await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: memberToken,
      body: { body: 'Second reply', parentMessageId: root.body.id },
    });

    const rootList = await api<{ items: MessageResponse[] }>(
      context,
      'GET',
      `/conversations/${channelId}/messages`,
      { token: managerToken },
    );
    const parent = rootList.body.items.find((message) => message.id === root.body.id);
    assert.equal(parent?.replyCount, 2);
    assert.ok(
      !rootList.body.items.some((message) => message.body === 'First reply'),
      'replies must not appear in the root listing',
    );

    const thread = await api<{ items: MessageResponse[] }>(
      context,
      'GET',
      `/conversations/${channelId}/messages?parentMessageId=${root.body.id}`,
      { token: managerToken },
    );
    assert.equal(thread.body.items.length, 2);
  });

  test('a reply cannot be attached to a message in another conversation', async () => {
    const other = await api<ConversationResponse>(context, 'POST', '/conversations', {
      token: managerToken,
      body: { kind: 'group', name: 'Cross-post guard', visibility: 'private' },
    });
    const foreign = await api<MessageResponse>(context, 'POST', `/conversations/${other.body.id}/messages`, {
      token: managerToken,
      body: { body: 'Elsewhere' },
    });

    const response = await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'Wrong thread', parentMessageId: foreign.body.id },
    });
    assert.equal(response.status, 422);
  });

  test('reactions toggle and are attributed', async () => {
    const message = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'React to me' },
    });

    const added = await api<{ added: boolean }>(
      context,
      'POST',
      `/conversations/${channelId}/messages/${message.body.id}/reactions`,
      { token: memberToken, body: { emoji: '🎉' } },
    );
    assert.equal(added.body.added, true);

    const removed = await api<{ added: boolean }>(
      context,
      'POST',
      `/conversations/${channelId}/messages/${message.body.id}/reactions`,
      { token: memberToken, body: { emoji: '🎉' } },
    );
    assert.equal(removed.body.added, false);
  });

  test('editing marks the message, deleting redacts it but keeps the thread', async () => {
    const message = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: memberToken,
      body: { body: 'Original wording' },
    });

    const edited = await api<MessageResponse>(
      context,
      'PATCH',
      `/conversations/${channelId}/messages/${message.body.id}`,
      { token: memberToken, body: { body: 'Corrected wording' } },
    );
    assert.equal(edited.body.body, 'Corrected wording');
    assert.ok(edited.body.editedAt, 'an edit must be visible to readers');

    // Someone else cannot edit it.
    const foreignEdit = await api(context, 'PATCH', `/conversations/${channelId}/messages/${message.body.id}`, {
      token: managerToken,
      body: { body: 'Hijacked' },
    });
    assert.equal(foreignEdit.status, 403);

    const deleted = await api(context, 'DELETE', `/conversations/${channelId}/messages/${message.body.id}`, {
      token: memberToken,
    });
    assert.equal(deleted.status, 204);

    const list = await api<{ items: MessageResponse[] }>(context, 'GET', `/conversations/${channelId}/messages`, {
      token: managerToken,
    });
    const tombstone = list.body.items.find((entry) => entry.id === message.body.id);
    assert.ok(tombstone, 'the message should remain as a tombstone');
    assert.equal(tombstone.body, '', 'deleted content must not be served');
    assert.ok(tombstone.deletedAt);
  });

  test('unread counts clear when the conversation is read', async () => {
    await api(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'Something new for the unread count' },
    });

    const before = await api<{ items: ConversationResponse[] }>(context, 'GET', '/conversations', {
      token: memberToken,
    });
    assert.ok((before.body.items.find((entry) => entry.id === channelId)?.unreadCount ?? 0) > 0);

    const read = await api(context, 'POST', `/conversations/${channelId}/read`, { token: memberToken, body: {} });
    assert.equal(read.status, 200);

    const after = await api<{ items: ConversationResponse[] }>(context, 'GET', '/conversations', {
      token: memberToken,
    });
    assert.equal(after.body.items.find((entry) => entry.id === channelId)?.unreadCount, 0);
  });

  test('a direct message is created once, however many times it is opened', async () => {
    const first = await api<ConversationResponse>(context, 'POST', '/conversations/direct', {
      token: managerToken,
      body: { userId: memberId },
    });
    const second = await api<ConversationResponse>(context, 'POST', '/conversations/direct', {
      token: memberToken,
      body: { userId: (await api<{ actor: { id: string } }>(context, 'GET', '/whoami', { token: managerToken })).body.actor.id },
    });
    assert.equal(first.body.id, second.body.id, 'the same pair must share one DM');
  });

  test('you cannot DM yourself', async () => {
    const response = await api(context, 'POST', '/conversations/direct', {
      token: memberToken,
      body: { userId: memberId },
    });
    assert.equal(response.status, 422);
  });

  test('private groups are invite-only, public channels are joinable', async () => {
    const outsider = await login(context, DEMO.frontend);
    const privateGroup = await api<ConversationResponse>(context, 'POST', '/conversations', {
      token: managerToken,
      body: { kind: 'group', name: 'Closed door', visibility: 'private' },
    });
    assert.equal(
      (await api(context, 'POST', `/conversations/${privateGroup.body.id}/join`, { token: outsider })).status,
      403,
    );

    const publicChannel = await api<ConversationResponse>(context, 'POST', '/conversations', {
      token: managerToken,
      body: { kind: 'channel', name: 'open-floor', visibility: 'public' },
    });
    assert.equal(
      (await api(context, 'POST', `/conversations/${publicChannel.body.id}/join`, { token: outsider })).status,
      200,
    );
  });

  test('the group owner cannot walk out and orphan the group', async () => {
    const group = await api<ConversationResponse>(context, 'POST', '/conversations', {
      token: managerToken,
      body: { kind: 'group', name: 'Ownership handover', visibility: 'private', memberIds: [memberId] },
    });
    const leave = await api(context, 'POST', `/conversations/${group.body.id}/leave`, { token: managerToken });
    assert.equal(leave.status, 409);

    // After handing ownership over, leaving is allowed.
    const handover = await api(context, 'PUT', `/conversations/${group.body.id}/members/${memberId}/role`, {
      token: managerToken,
      body: { role: 'owner' },
    });
    assert.equal(handover.status, 204);
    assert.equal(
      (await api(context, 'POST', `/conversations/${group.body.id}/leave`, { token: managerToken })).status,
      204,
    );
  });

  test('pinned messages are listed separately', async () => {
    const message = await api<MessageResponse>(context, 'POST', `/conversations/${channelId}/messages`, {
      token: managerToken,
      body: { body: 'Runbook: rotate keys quarterly.' },
    });
    const pinned = await api<{ pinned: boolean }>(
      context,
      'POST',
      `/conversations/${channelId}/messages/${message.body.id}/pin`,
      { token: managerToken },
    );
    assert.equal(pinned.body.pinned, true);

    const list = await api<{ items: MessageResponse[] }>(context, 'GET', `/conversations/${channelId}/pinned`, {
      token: managerToken,
    });
    assert.ok(list.body.items.some((entry) => entry.id === message.body.id));
  });
});
