import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMention, mentionsEveryone, parseMentions, toPlainText } from '../../src/lib/mentions.ts';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

test('structured mentions resolve straight to user ids', () => {
  const parsed = parseMentions(`Hi @[Ada Lovelace](${ADA}) and @[Bob Ross](${BOB})`);
  assert.deepEqual(parsed.userIds, [ADA, BOB]);
  assert.deepEqual(parsed.handles, []);
});

test('bare handles are collected for directory lookup', () => {
  const parsed = parseMentions('ping @priya.nair about this');
  assert.deepEqual(parsed.handles, ['priya.nair']);
  assert.deepEqual(parsed.userIds, []);
});

test('an email address is not a mention', () => {
  const parsed = parseMentions('mail ops@teamspace.dev for access');
  assert.deepEqual(parsed.handles, []);
});

test('@here and friends are directives, not people', () => {
  const parsed = parseMentions('@here standup in five');
  assert.deepEqual(parsed.handles, []);
  assert.equal(mentionsEveryone('@here standup in five'), true);
  assert.equal(mentionsEveryone('@channel ship it'), true);
  assert.equal(mentionsEveryone('nothing to see'), false);
});

test('duplicate mentions of the same person collapse', () => {
  const parsed = parseMentions(`@[Ada](${ADA}) ... and again @[Ada](${ADA})`);
  assert.deepEqual(parsed.userIds, [ADA]);
});

test('mention markup renders as readable text', () => {
  assert.equal(toPlainText(`ping @[Ada Lovelace](${ADA}) now`), 'ping @Ada Lovelace now');
});

test('formatting strips characters that would break the markup', () => {
  assert.equal(formatMention(ADA, 'Ada [the] (first)'), `@[Ada the first](${ADA})`);
});
