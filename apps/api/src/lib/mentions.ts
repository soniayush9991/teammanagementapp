/**
 * Mentions are written as @[Display Name](user-id) by the composer, which
 * keeps the stored body stable when someone changes their display name and
 * makes the mention list unambiguous (two people can share a first name).
 * A bare @handle is also recognised so typed-by-hand mentions still work.
 */
const STRUCTURED_MENTION = /@\[([^\]]{1,120})\]\(([0-9a-fA-F-]{36})\)/g;
const BARE_MENTION = /(?:^|[\s(])@([a-zA-Z0-9._-]{2,60})/g;

export interface ParsedMentions {
  /** User ids resolved directly from structured mentions. */
  userIds: string[];
  /** Handles that still need resolving against the directory. */
  handles: string[];
}

export function parseMentions(body: string): ParsedMentions {
  const userIds = new Set<string>();
  const handles = new Set<string>();

  for (const match of body.matchAll(STRUCTURED_MENTION)) {
    const id = match[2];
    if (id) userIds.add(id.toLowerCase());
  }

  // @here and @channel are group-level directives, not people.
  for (const match of body.matchAll(BARE_MENTION)) {
    const handle = match[1];
    if (handle && !['here', 'channel', 'everyone'].includes(handle.toLowerCase())) {
      handles.add(handle.toLowerCase());
    }
  }

  return { userIds: [...userIds], handles: [...handles] };
}

/** True when the body addresses the whole conversation. */
export function mentionsEveryone(body: string): boolean {
  return /(?:^|\s)@(here|channel|everyone)\b/i.test(body);
}

/** Renders a mention token for the composer. */
export function formatMention(userId: string, displayName: string): string {
  return `@[${displayName.replace(/[[\]()]/g, '')}](${userId})`;
}

/** Strips mention markup down to plain text for previews and notifications. */
export function toPlainText(body: string): string {
  return body.replace(STRUCTURED_MENTION, (_match, displayName: string) => `@${displayName}`);
}
