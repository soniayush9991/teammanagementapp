# 13. Search and retention strategy

## Search

PostgreSQL full-text search, not a separate engine. At the scale this product
targets — thousands of users, millions of messages — a dedicated cluster adds
an eventually-consistent copy of the data, a second permission model to keep in
sync, and an extra service to operate, in exchange for latency the database
already delivers. The migration path is described at the end.

### Indexed content

| Entity | Indexed | Weighting |
|---|---|---|
| Tasks | key, title, description | key and title `A`, description `B` |
| Messages | body | uniform |
| Attachments | filename (dots split into words) | uniform |

`search_vector` columns are maintained by triggers, so nothing can be written
without being indexed — a nightly reindex job would be a source of silent gaps.

```sql
CREATE INDEX tasks_search_idx    ON tasks      USING GIN (search_vector);
CREATE INDEX messages_search_idx ON messages   USING GIN (search_vector);
CREATE INDEX attachments_search_idx ON attachments USING GIN (search_vector);
```

### Query parsing

`websearch_to_tsquery` rather than `to_tsquery`, because end users type things
like `"full-text search" -draft (urgent)`. `to_tsquery` would raise a syntax
error on that input; `websearch_to_tsquery` interprets quoted phrases and
`-exclusions` the way a search box implies, and never throws on punctuation.

### Ranking and snippets

Results are ordered by `ts_rank` then recency. Snippets come from `ts_headline`
with `<mark>` delimiters.

Message snippets strip mention markup **before** highlighting:

```sql
ts_headline('english',
  regexp_replace(m.body, '@\[([^\]]+)\]\([0-9a-fA-F-]{36}\)', '@\1', 'g'),
  websearch_to_tsquery('english', $3), 'StartSel=<mark>, StopSel=</mark>, …')
```

Cleaning afterwards would not work: `ts_headline` truncates to a window and
regularly cuts a `@[Name](uuid)` token in half, leaving unrepairable markup on
screen.

### Permission-aware results

Every branch of the search union carries its own visibility predicate — a hit
can never surface a task in a team you are not on, or a message from a
conversation you are not in. Public channels are readable by anyone in the
organization; DMs are readable only by their participants.

This is enforced in SQL rather than by filtering afterwards, so a result the
caller may not see is never fetched, counted, or paged over.

### Filters

By type (`task`, `message`, `attachment`), conversation, author, team, and date
range.

### Typeahead

Separate endpoint backed by trigram indexes:

```sql
CREATE INDEX users_name_trgm_idx ON users USING GIN (display_name gin_trgm_ops);
CREATE INDEX tasks_title_trgm_idx ON tasks USING GIN (title gin_trgm_ops);
```

Trigram indexes make `ILIKE '%pri%'` fast, which full-text cannot do because
it matches whole lexemes, not prefixes inside a word.

### When to outgrow this

Move to OpenSearch or Elasticsearch when any of these becomes true:

- Message volume passes roughly 10 million rows **and** p95 search latency
  exceeds 300ms with the GIN indexes warm.
- Requirements arrive for fuzzy matching, synonyms, or per-user relevance
  tuning.
- Search traffic starts competing with transactional load for buffer cache.

The migration keeps PostgreSQL as the system of record and streams changes
outward; the permission predicates must be reimplemented as filters on the
index, which is the genuinely hard part and the reason to defer it.

---

## Retention

### Policy

| Data | Default | Configurable | Rationale |
|---|---|---|---|
| Messages | **365 days** | Yes, per organization | The stated requirement |
| Attachments | 365 days | Yes | Tracks the messages they belong to |
| Notifications | 90 days (read only) | Yes | Ephemeral by nature |
| Audit logs | 730 days | Yes | Compliance outlives conversation |
| Tasks | Indefinite | No | Work history is the record of what the team did |

Policies live in `retention_policies` and are editable by an admin. Each has an
`enforced` flag: with it off, the job reports what it *would* delete without
deleting, which is how a policy change gets verified before it bites.

### Why partitioning

A 365-day policy enforced with `DELETE FROM messages WHERE created_at < …`
would, on a busy deployment, delete millions of rows per run, leave dead tuples
for autovacuum to chase, bloat both the heap and three GIN indexes, and hold
locks while doing it.

Instead `messages` is `PARTITION BY RANGE (created_at)`, one partition per
month:

```
messages
├── messages_2025_09   ← older than 365 days: DETACH, then DROP
├── messages_2025_10
├── …
├── messages_2026_09   ← current
└── messages_2026_10   ← provisioned ahead
```

Dropping an expired month is a **metadata operation**: it reclaims the space
immediately, produces no dead tuples, and does not touch the remaining data.

The cost is the composite primary key `(id, created_at)` that a partitioned
table requires, which propagates to every table referencing a message. That is
a real complexity tax, paid once in the schema, in exchange for retention that
stays cheap forever.

### The job

`jobs/retention.ts`, daily:

1. **Drop whole expired partitions.** `DETACH PARTITION` first so the drop
   never blocks readers of the parent table, then `DROP TABLE`.
2. **Delete stragglers** inside the boundary partition, which is only partly
   outside the window.
3. **Purge orphaned uploads** — attachment rows never linked to a message,
   task or comment, older than a day.
4. **Purge read notifications** and expired audit logs per policy.
5. **Provision ahead** — ensure the current and next two months exist, so an
   insert can never land outside a partition range.
6. **Housekeeping** — expired refresh tokens, stale reminder dedupe markers.

### Object storage

Attachment bytes live in S3-compatible storage. The database row is the index;
the bucket carries a lifecycle rule on the same prefix so the objects expire
alongside their rows. Deleting a row does not delete the object synchronously —
a failed delete would otherwise leave the row gone and the file orphaned, which
is the wrong way round for a retention guarantee.

### Verification

Two integration tests cover this end to end: one confirms that recent history
is retained and future partitions are provisioned; the other plants a message
two years in the past, runs the job, and asserts the partition is dropped and
the row is gone.
