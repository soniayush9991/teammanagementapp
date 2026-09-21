import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Conversation, Message } from '@teamspace/shared';
import { api, ApiError, qs } from '../api/client';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Textarea,
  formatRelativeTime,
} from '../components/ui';
import { useRealtime, type ServerEvent } from '../hooks/useRealtime';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../state/ToastContext';

const QUICK_REACTIONS = ['👍', '🎉', '👀', '✅'];

export function ChatPage(): JSX.Element {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { notify } = useToast();
  const realtime = useRealtime();

  const [draft, setDraft] = useState('');
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadDraft, setThreadDraft] = useState('');
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () =>
      api.get<{ items: Conversation[] }>('/conversations?includePublic=true&limit=50').then((r) => r.items),
  });

  const conversations = useMemo(() => conversationsQuery.data ?? [], [conversationsQuery.data]);
  const activeId = conversationId ?? conversations[0]?.id;
  const active = conversations.find((conversation) => conversation.id === activeId);

  const messagesQuery = useQuery({
    queryKey: ['messages', activeId],
    queryFn: () =>
      api.get<{ items: Message[]; nextCursor: string | null }>(
        `/conversations/${activeId}/messages${qs({ limit: 50 })}`,
      ),
    enabled: Boolean(activeId),
  });

  const threadQuery = useQuery({
    queryKey: ['messages', activeId, 'thread', threadRoot?.id],
    queryFn: () =>
      api
        .get<{ items: Message[] }>(
          `/conversations/${activeId}/messages${qs({ parentMessageId: threadRoot?.id, limit: 50 })}`,
        )
        .then((r) => r.items),
    enabled: Boolean(activeId && threadRoot),
  });

  // Subscribe the socket to every conversation in the sidebar so unread
  // counts stay live even for the ones not currently open.
  useEffect(() => {
    if (conversations.length > 0) {
      realtime.subscribeToConversations(conversations.map((conversation) => conversation.id));
    }
  }, [conversations, realtime]);

  // Typing indicators are transient, so they bypass the query cache.
  useEffect(
    () =>
      realtime.subscribe((event: ServerEvent) => {
        if (event.type !== 'typing' || event.conversationId !== activeId) return;
        setTypingUsers((current) => {
          const next = { ...current };
          if (event.isTyping) next[event.userId] = event.displayName;
          else delete next[event.userId];
          return next;
        });
      }),
    [realtime, activeId],
  );

  // Opening a conversation marks it read.
  useEffect(() => {
    if (!activeId) return;
    void api.post(`/conversations/${activeId}/read`, {}).then(
      () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      () => undefined,
    );
  }, [activeId, queryClient]);

  const send = useMutation({
    mutationFn: ({ body, parentMessageId }: { body: string; parentMessageId?: string }) =>
      api.post<Message>(`/conversations/${activeId}/messages`, { body, parentMessageId }),
    onSuccess: (_message, variables) => {
      if (variables.parentMessageId) setThreadDraft('');
      else setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['messages', activeId] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Message not sent', 'error'),
  });

  const react = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      api.post(`/conversations/${activeId}/messages/${messageId}/reactions`, { emoji }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', activeId] }),
  });

  const remove = useMutation({
    mutationFn: (messageId: string) => api.delete(`/conversations/${activeId}/messages/${messageId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', activeId] }),
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Could not delete', 'error'),
  });

  const announceTyping = (): void => {
    if (!activeId) return;
    realtime.send({ type: 'typing', conversationId: activeId, isTyping: true });
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      realtime.send({ type: 'typing', conversationId: activeId, isTyping: false });
    }, 2500);
  };

  const onSend = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim()) send.mutate({ body: draft.trim() });
  };

  if (conversationsQuery.isPending) return <LoadingBlock rows={6} label="Loading conversations" />;
  if (conversationsQuery.error) {
    return <ErrorBlock error={conversationsQuery.error} onRetry={() => void conversationsQuery.refetch()} />;
  }
  if (conversations.length === 0) {
    return <EmptyState icon="◎" title="No conversations yet" description="Create a group from the Groups page." />;
  }

  const typingNames = Object.values(typingUsers);
  const highlightMessageId = searchParams.get('message');

  return (
    <div className={threadRoot ? 'chat chat--with-thread' : 'chat'}>
      <aside className="chat__list" aria-label="Conversations">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className={`conversation-item${conversation.id === activeId ? ' conversation-item--active' : ''}`}
            onClick={() => {
              setThreadRoot(null);
              navigate(`/chat/${conversation.id}`);
            }}
            aria-current={conversation.id === activeId ? 'true' : undefined}
          >
            <Avatar
              name={conversation.name ?? conversation.counterpart?.displayName ?? 'Conversation'}
              size="sm"
            />
            <span style={{ minWidth: 0 }}>
              <span className="conversation-item__name truncate" style={{ display: 'block' }}>
                {conversation.kind === 'channel' && '# '}
                {conversation.name ?? conversation.counterpart?.displayName ?? 'Direct message'}
              </span>
              {conversation.lastMessageAt && (
                <span className="tiny">{formatRelativeTime(conversation.lastMessageAt)}</span>
              )}
            </span>
            {conversation.unreadCount > 0 && (
              <span className="conversation-item__unread" aria-label={`${conversation.unreadCount} unread`}>
                {conversation.unreadCount}
              </span>
            )}
          </button>
        ))}
      </aside>

      <section className="chat__panel" aria-label="Messages">
        <header className="chat__header">
          <Avatar name={active?.name ?? active?.counterpart?.displayName ?? 'Conversation'} size="sm" />
          <div style={{ minWidth: 0 }}>
            <strong className="truncate" style={{ display: 'block' }}>
              {active?.kind === 'channel' && '#'}
              {active?.name ?? active?.counterpart?.displayName ?? 'Direct message'}
            </strong>
            {active?.topic && <span className="tiny truncate">{active.topic}</span>}
          </div>
          <span className="spacer" />
          <span className="tiny">{active?.memberCount} members</span>
        </header>

        {/* column-reverse keeps the newest message pinned to the bottom
            without imperative scrolling. */}
        <div className="chat__messages">
          {messagesQuery.isPending && <LoadingBlock rows={4} label="Loading messages" />}
          {(messagesQuery.data?.items ?? []).map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              isMine={message.authorId === user?.id}
              highlighted={message.id === highlightMessageId}
              onReply={() => setThreadRoot(message)}
              onReact={(emoji) => react.mutate({ messageId: message.id, emoji })}
              onDelete={() => remove.mutate(message.id)}
            />
          ))}
          {messagesQuery.data?.items.length === 0 && (
            <EmptyState icon="◎" title="No messages yet" description="Say something to get started." />
          )}
        </div>

        <div className="chat__composer">
          <p className="chat__typing" aria-live="polite">
            {typingNames.length === 1
              ? `${typingNames[0]} is typing…`
              : typingNames.length > 1
                ? `${typingNames.length} people are typing…`
                : ''}
          </p>
          <form onSubmit={onSend}>
            <label className="sr-only" htmlFor="composer">
              Message {active?.name ?? 'this conversation'}
            </label>
            <Textarea
              id="composer"
              rows={2}
              value={draft}
              placeholder="Write a message…  @ to mention, Enter to send"
              onChange={(event) => {
                setDraft(event.target.value);
                announceTyping();
              }}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter starts a new line.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (draft.trim()) send.mutate({ body: draft.trim() });
                }
              }}
            />
            <div className="row row--between" style={{ marginTop: 'var(--space-2)' }}>
              <span className="tiny">Enter to send · Shift+Enter for a new line</span>
              <Button type="submit" size="sm" disabled={!draft.trim() || send.isPending}>
                Send
              </Button>
            </div>
          </form>
        </div>
      </section>

      {threadRoot && (
        <aside className="chat__thread" aria-label="Thread">
          <header className="chat__header">
            <strong>Thread</strong>
            <span className="spacer" />
            <Button variant="ghost" size="sm" onClick={() => setThreadRoot(null)} aria-label="Close thread">
              ✕
            </Button>
          </header>

          <div className="chat__messages" style={{ flexDirection: 'column' }}>
            <MessageRow message={threadRoot} isMine={threadRoot.authorId === user?.id} />
            <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle)', width: '100%' }} />
            {(threadQuery.data ?? []).slice().reverse().map((reply) => (
              <MessageRow key={reply.id} message={reply} isMine={reply.authorId === user?.id} />
            ))}
          </div>

          <div className="chat__composer">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (threadDraft.trim()) send.mutate({ body: threadDraft.trim(), parentMessageId: threadRoot.id });
              }}
            >
              <label className="sr-only" htmlFor="thread-composer">
                Reply in thread
              </label>
              <Textarea
                id="thread-composer"
                rows={2}
                value={threadDraft}
                placeholder="Reply…"
                onChange={(event) => setThreadDraft(event.target.value)}
              />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
                <Button type="submit" size="sm" disabled={!threadDraft.trim()}>
                  Reply
                </Button>
              </div>
            </form>
          </div>
        </aside>
      )}
    </div>
  );
}

function MessageRow({
  message,
  isMine,
  highlighted,
  onReply,
  onReact,
  onDelete,
}: {
  message: Message;
  isMine: boolean;
  highlighted?: boolean;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  onDelete?: () => void;
}): JSX.Element {
  return (
    <article
      className="message"
      style={highlighted ? { background: 'var(--accent-subtle)' } : undefined}
      id={`message-${message.id}`}
    >
      <Avatar name={message.authorName} src={message.authorAvatarUrl} size="sm" />
      <div className="message__body">
        <div className="message__meta">
          <span className="message__author">{message.authorName}</span>
          <span className="tiny">{formatRelativeTime(message.createdAt)}</span>
          {message.editedAt && <span className="tiny">(edited)</span>}
          {message.isPinned && <span className="badge badge--accent">pinned</span>}
          <span className="spacer" />
          {onReact && (
            <span className="message__actions">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="reaction"
                  onClick={() => onReact(emoji)}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
              {onReply && (
                <Button variant="ghost" size="sm" onClick={onReply}>
                  Reply
                </Button>
              )}
              {isMine && onDelete && (
                <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete message">
                  ✕
                </Button>
              )}
            </span>
          )}
        </div>

        {message.deletedAt ? (
          <p className="message__text message__text--deleted">This message was deleted.</p>
        ) : (
          <p className="message__text">{renderMentions(message.body)}</p>
        )}

        {message.attachments.length > 0 && (
          <div className="row row--wrap" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            {message.attachments.map((attachment) => (
              <a key={attachment.id} href={attachment.url ?? '#'} className="badge" download>
                📎 {attachment.fileName}
              </a>
            ))}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="row row--wrap" style={{ gap: 4, marginTop: 'var(--space-2)' }}>
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className="reaction"
                onClick={() => onReact?.(reaction.emoji)}
                aria-label={`${reaction.emoji}, ${reaction.count} reaction(s)`}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        )}

        {message.replyCount > 0 && onReply && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onReply} style={{ paddingLeft: 0 }}>
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Renders @[Name](uuid) tokens as highlighted names. The body is never
 * injected as HTML — each fragment stays a React text node, so a message
 * containing markup cannot become markup.
 */
function renderMentions(body: string): (string | JSX.Element)[] {
  const pattern = /@\[([^\]]{1,120})\]\(([0-9a-fA-F-]{36})\)/g;
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match = pattern.exec(body);
  let key = 0;

  while (match) {
    if (match.index > lastIndex) parts.push(body.slice(lastIndex, match.index));
    parts.push(
      <span className="message__mention" key={`mention-${key++}`}>
        @{match[1]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
    match = pattern.exec(body);
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}
