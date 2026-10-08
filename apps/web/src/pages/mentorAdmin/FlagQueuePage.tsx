import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, qs } from '../../api/client';
import { useFilterOptions, type FlagDetail, type FlagListItem } from '../../api/mentorAdmin';
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Select, Textarea, formatRelativeTime } from '../../components/ui';
import { FLAG_KIND_LABEL, formatVisitTime } from '../../components/mentor/format';
import { PeriodSelect } from '../../components/mentorAdmin/parts';
import { useAuth } from '../../state/AuthContext';
import { useToast } from '../../state/ToastContext';

const STATUS_LABEL: Record<FlagListItem['status'], string> = {
  new: 'New',
  in_review: 'In review',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  escalated: 'Escalated',
};
const STATUS_GLYPH: Record<FlagListItem['status'], string> = { new: '◐', in_review: '◑', confirmed: '■', dismissed: '○', escalated: '▲' };

const CONFIRM_REASONS = [['audit_agrees', 'Audit agrees with the flag'], ['nodal_validated', 'Validated by nodal person'], ['clear_contradiction', 'Clear contradiction in the record']];
const DISMISS_REASONS = [['false_positive', 'False positive'], ['legitimate_variation', 'Legitimate variation'], ['system_data_error', 'System or data error']];

const PARAM_KEYS = ['status', 'district', 'block', 'kind', 'rule_code', 'min_age_days', 'mentor', 'period'];

/** A4: the review queue and its evidence pane. Every action is recorded with who, when, from, to, and why. */
export function FlagQueuePage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const get = (key: string): string => params.get(key) ?? '';
  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'district') next.delete('block');
    setParams(next, { replace: true });
  };
  const selected = get('flag');
  const { data: options } = useFilterOptions();

  const list = useQuery({
    queryKey: ['mentor-admin', 'flags', Object.fromEntries(PARAM_KEYS.map((key) => [key, get(key)]))],
    queryFn: () =>
      api.get<{ items: FlagListItem[]; total: number }>(
        `/admin/flags${qs({ status: get('status'), district: get('district'), block: get('block'), kind: get('kind'), rule_code: get('rule_code'), min_age_days: get('min_age_days'), mentor_id: get('mentor'), period_id: get('period'), limit: 100 })}`,
      ),
  });

  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Flag filters">
        <label className="filter">
          <span className="filter__label">Status</span>
          <Select value={get('status')} onChange={(e) => setParam('status', e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        <label className="filter">
          <span className="filter__label">District</span>
          <Select value={get('district')} onChange={(e) => setParam('district', e.target.value)} aria-label="District">
            <option value="">All districts</option>
            {options?.districts.map((d) => <option key={d}>{d}</option>)}
          </Select>
        </label>
        <label className="filter">
          <span className="filter__label">Block</span>
          <Select value={get('block')} onChange={(e) => setParam('block', e.target.value)} aria-label="Block">
            <option value="">All blocks</option>
            {(options?.blocks ?? []).filter((b) => !get('district') || b.district === get('district')).map((b) => <option key={`${b.district}${b.block}`}>{b.block}</option>)}
          </Select>
        </label>
        <label className="filter">
          <span className="filter__label">Type</span>
          <Select value={get('kind')} onChange={(e) => setParam('kind', e.target.value)} aria-label="Rule type">
            <option value="">Any type</option>
            <option value="inflation">Inflation</option>
            <option value="contradiction">Contradiction</option>
          </Select>
        </label>
        <label className="filter">
          <span className="filter__label">Rule</span>
          <Input value={get('rule_code')} onChange={(e) => setParam('rule_code', e.target.value)} placeholder="e.g. C-01" aria-label="Rule code" />
        </label>
        <label className="filter">
          <span className="filter__label">At least (days old)</span>
          <Input type="number" min={0} value={get('min_age_days')} onChange={(e) => setParam('min_age_days', e.target.value)} aria-label="Minimum age in days" />
        </label>
        <PeriodSelect value={get('period')} onChange={(id) => setParam('period', id)} />
        {get('mentor') && <Button variant="ghost" size="sm" onClick={() => setParam('mentor', '')}>Showing one mentor · clear</Button>}
      </div>

      <div className="split">
        <Card title={`Queue${list.data ? ` (${list.data.total})` : ''}`} flush>
          {list.isPending && <div style={{ padding: 'var(--space-4)' }}><LoadingBlock rows={5} label="Loading flags" /></div>}
          {list.error && <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />}
          {list.data && list.data.items.length === 0 && <EmptyState icon="●" title="Nothing in the queue" description="No flags match these filters." />}
          {list.data && list.data.items.length > 0 && (
            <ul className="queue">
              {list.data.items.map((flag) => (
                <li key={flag.id}>
                  <button type="button" className={`queue__item${flag.id === selected ? ' queue__item--active' : ''}`} aria-current={flag.id === selected} onClick={() => setParam('flag', flag.id)}>
                    <span className="queue__top">
                      <strong>{flag.mentor_name}</strong>
                      <Badge tone={flag.status === 'escalated' ? 'overloaded' : flag.status === 'confirmed' ? 'accent' : undefined}>
                        <span aria-hidden="true">{STATUS_GLYPH[flag.status]}</span> {STATUS_LABEL[flag.status]}
                      </Badge>
                    </span>
                    <span className="queue__meta">
                      {FLAG_KIND_LABEL[flag.kind]} · {flag.rule_code} · {flag.severity} severity
                      {flag.repeat_count > 0 ? ` · repeated ${flag.repeat_count}×` : ''}
                    </span>
                    <span className="tiny">{flag.school_id} · {Math.floor(flag.age_days)} d old</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div>{selected ? <EvidencePane flagId={selected} /> : <Card><EmptyState icon="◔" title="Select a flag" description="Its evidence and review history appear here." /></Card>}</div>
      </div>
    </div>
  );
}

function EvidencePane({ flagId }: { flagId: string }): JSX.Element {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['mentor-admin', 'flag', flagId],
    queryFn: () => api.get<FlagDetail>(`/admin/flags/${flagId}`),
  });
  if (isPending) return <Card><LoadingBlock rows={6} label="Loading evidence" /></Card>;
  if (error || !data) return <Card><ErrorBlock error={error} onRetry={() => void refetch()} /></Card>;

  const { flag, visit, mentor } = data;
  return (
    <div className="stack">
      <Card title={`${mentor.name} · ${FLAG_KIND_LABEL[flag.kind as 'inflation' | 'contradiction'] ?? flag.kind}`}>
        <p><strong>Why it was flagged:</strong> {flag.explanation}</p>
        <p className="tiny">
          Rule {flag.ruleCode} · {flag.severity} severity · raised {formatRelativeTime(flag.createdAt)}
          {flag.repeatCount > 0 ? ` · the same rule fired ${flag.repeatCount} other time(s) in 60 days` : ''}
          {flag.lateConfirmed ? ' · confirmed after its period closed' : ''}
        </p>
        {Object.keys(flag.evidence).length > 0 && (
          <details className="visit-list" open>
            <summary>Related observations</summary>
            <dl className="facts" style={{ marginTop: 'var(--space-2)' }}>
              {Object.entries(flag.evidence).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll('_', ' ')}</dt>
                  <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </Card>

      <Card title="The visit">
        <dl className="facts">
          <div><dt>School</dt><dd>{visit.school_id}</dd></div>
          <div><dt>Started</dt><dd>{formatVisitTime(visit.started_at)}</dd></div>
          <div><dt>Ended</dt><dd>{formatVisitTime(visit.ended_at)} ({Math.round(visit.duration_minutes)} min)</dd></div>
          <div><dt>Submitted</dt><dd>{formatVisitTime(visit.submitted_at)}</dd></div>
          <div><dt>Location check</dt><dd>{visit.location_status === 'verified' ? '● Verified' : `▲ ${visit.location_status}`}</dd></div>
          <div><dt>Assignment</dt><dd>{visit.assignment_valid ? '● In allocation' : '▲ Not in allocation'}</dd></div>
          <div><dt>Spot assessments</dt><dd>{visit.spot_completed} of {visit.spot_applicable}</dd></div>
          <div><dt>Checks on this visit</dt><dd>{visit.inflation_checks} inflation · {visit.consistency_checks} consistency</dd></div>
        </dl>
        {data.otherFlagsOnVisit.length > 0 && (
          <p className="tiny">Also flagged on this visit: {data.otherFlagsOnVisit.map((other) => `${other.rule_code} (${other.status.replace('_', ' ')})`).join(', ')}</p>
        )}
      </Card>

      <ReviewActions detail={data} />

      <Card title="Review history">
        {data.reviews.length === 0 ? (
          <p className="muted">No reviewer action yet.</p>
        ) : (
          <ol className="timeline">
            {data.reviews.map((review) => (
              <li key={review.id}>
                <strong>{review.decision.replace('_', ' ')}</strong> · {review.from_status.replace('_', ' ')} → {review.to_status.replace('_', ' ')}
                <span className="tiny block">
                  {review.reviewer ?? 'Unknown'} · {formatVisitTime(review.decided_at)}
                  {review.reason_code ? ` · ${review.reason_code.replaceAll('_', ' ')}` : ''}
                </span>
                {review.note && <span className="muted block">{review.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function ReviewActions({ detail }: { detail: FlagDetail }): JSX.Element {
  const { flag } = detail;
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const final = flag.status === 'confirmed' || flag.status === 'dismissed';
  const needsAdmin = flag.status === 'escalated' && user?.role !== 'admin';

  const decide = useMutation({
    mutationFn: (decision: string) => api.post(`/admin/flags/${flag.id}/decision`, { decision, reasonCode: reason || undefined, note: note.trim() || undefined }),
    onSuccess: (_result, decision) => {
      notify(decision === 'note' ? 'Note added' : `Flag ${decision.replace('_', ' ')} recorded`, 'success');
      setNote('');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['mentor-admin'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'That action failed', 'error'),
  });
  const busy = decide.isPending;

  if (!flag.canReview) {
    return <Card title="Review"><p className="muted">This flag is on your own record, so someone else has to review it.</p></Card>;
  }

  return (
    <Card title="Review">
      {final && <p className="muted">This flag is {flag.status}. A decision is final; you can still add a note.</p>}
      {needsAdmin && <p className="muted">This flag was escalated. An admin has to resolve it; you can add a note.</p>}
      <div className="stack">
        {!final && !needsAdmin && (
          <Field label="Reason (required to confirm or dismiss)" htmlFor="review-reason">
            <Select id="review-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose a reason…</option>
              <optgroup label="To confirm">{CONFIRM_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
              <optgroup label="To dismiss">{DISMISS_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
            </Select>
          </Field>
        )}
        <Field label="Note" htmlFor="review-note">
          <Textarea id="review-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
        <div className="row row--wrap">
          {!final && !needsAdmin && (
            <>
              {flag.status === 'new' && <Button variant="secondary" disabled={busy} onClick={() => decide.mutate('start_review')}>Start review</Button>}
              <Button disabled={busy || !CONFIRM_REASONS.some(([v]) => v === reason)} onClick={() => decide.mutate('confirm')}>Confirm issue</Button>
              <Button variant="secondary" disabled={busy || !DISMISS_REASONS.some(([v]) => v === reason)} onClick={() => decide.mutate('dismiss')}>Dismiss</Button>
              {flag.status !== 'escalated' && <Button variant="ghost" disabled={busy} onClick={() => decide.mutate('escalate')}>Escalate</Button>}
            </>
          )}
          <Button variant="ghost" disabled={busy || note.trim().length === 0} onClick={() => decide.mutate('note')}>Add note only</Button>
        </div>
        {!final && !needsAdmin && <p className="tiny">Only a confirmed issue affects the mentor's score. Choose a confirm reason to confirm, or a dismiss reason to dismiss.</p>}
      </div>
    </Card>
  );
}
