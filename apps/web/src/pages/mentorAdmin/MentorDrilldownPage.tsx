import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useDrilldown, type Drilldown } from '../../api/mentorAdmin';
import { Button, Card, EmptyState, ErrorBlock, Field, LoadingBlock, Textarea, formatRelativeTime } from '../../components/ui';
import { DeltaChip, ScoreFigure, StatusBadge } from '../../components/mentor/parts';
import { METRIC_COPY, formatCount, formatDay, formatPeriod, formatVisitTime } from '../../components/mentor/format';
import { TrendLine, oneDecimal, useFilters } from '../../components/mentorAdmin/parts';
import { useAuth } from '../../state/AuthContext';
import { useToast } from '../../state/ToastContext';

/** A3: everything behind one mentor's score, from the weights down to each visit and each review. */
export function MentorDrilldownPage(): JSX.Element {
  const { mentorId } = useParams();
  const { filters } = useFilters();
  const { data, isPending, error, refetch } = useDrilldown(mentorId, filters.period);
  const { can } = useAuth();

  if (isPending) return <LoadingBlock rows={6} label="Loading the mentor's report card" />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  const flagByVisit = new Map<string, Drilldown['evidence']['flags']>();
  for (const flag of data.evidence.flags) flagByVisit.set(flag.visitId, [...(flagByVisit.get(flag.visitId) ?? []), flag]);
  const chronological = [...data.trend].reverse();

  return (
    <div className="stack">
      <p>
        <Link to="/mentor-admin/mentors">← All mentors</Link>
      </p>

      <Card>
        <div className="hero">
          <div>
            <h2 className="card__title">{data.mentor.name}</h2>
            <p className="muted">{[data.mentor.role, data.mentor.district, data.mentor.block].filter(Boolean).join(' · ')}</p>
            <p className="tiny">
              {formatPeriod(data.period.startDate, data.period.endDate)} · active {data.mentor.activeFrom ? formatDay(data.mentor.activeFrom) : 'from the start'}
              {data.mentor.activeTo ? ` to ${formatDay(data.mentor.activeTo)}` : ''} · configuration v{data.configVersion}
              {data.scores.revision > 1 ? ` · revision ${data.scores.revision}` : ''}
            </p>
          </div>
          <div className="row row--wrap">
            <StatusBadge status={data.scores.status} />
            <Link className="btn btn--secondary btn--sm" to={`/mentor-admin/flags?mentor=${data.mentor.id}`}>Open audit cases</Link>
            {can('report:export') && (
              <Button variant="secondary" size="sm" onClick={() => exportCsv(data)}>
                Export CSV
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid--metrics">
        {[['Overall', data.scores.overall], ['Compliance', data.scores.compliance], ['Data reliability', data.scores.reliability]].map(([label, value]) => (
          <Card key={label as string}>
            <p className="metric__label">{label as string}</p>
            <ScoreFigure value={value as number | null} status={data.scores.status} size="md" label={label as string} />
          </Card>
        ))}
        <Card>
          <p className="metric__label">Change</p>
          <p className="metric__value">
            <DeltaChip delta={data.trend[0]?.delta ?? null} label="" />
            {data.trend[0]?.delta == null && '—'}
          </p>
        </Card>
      </div>

      <Card title="Drivers" flush>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="th--numeric">Numerator</th>
                <th scope="col" className="th--numeric">Denominator</th>
                <th scope="col" className="th--numeric">Value</th>
                <th scope="col" className="th--numeric">Share of score</th>
                <th scope="col" className="th--numeric">Points</th>
                <th scope="col" className="th--numeric">Rule version</th>
              </tr>
            </thead>
            <tbody>
              {data.drivers.map((driver) => (
                <tr key={driver.code}>
                  <th scope="row">
                    {METRIC_COPY[driver.code as keyof typeof METRIC_COPY]?.title ?? driver.code}
                    {!driver.applicable && <span className="tiny block">Not applicable — weight rescaled</span>}
                    {driver.code.endsWith('_reliability') && driver.applicable && <span className="tiny block">Numerator counts confirmed issues</span>}
                  </th>
                  <td className="td--numeric">{formatCount(driver.numerator)}</td>
                  <td className="td--numeric">{formatCount(driver.denominator)}</td>
                  <td className="td--numeric">{oneDecimal(driver.value)}</td>
                  <td className="td--numeric">{Math.round(driver.effectiveWeight * 100)}%</td>
                  <td className="td--numeric">{oneDecimal(driver.points)}</td>
                  <td className="td--numeric">v{driver.ruleVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Visit evidence" flush>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">School</th>
                <th scope="col">Started</th>
                <th scope="col" className="th--numeric">Minutes</th>
                <th scope="col">Validity</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.evidence.visits.map((visit) => (
                <tr key={visit.id}>
                  <th scope="row">{visit.schoolId}</th>
                  <td>{formatVisitTime(visit.startedAt)}</td>
                  <td className="td--numeric">{visit.durationMinutes === null ? '—' : Math.round(visit.durationMinutes)}</td>
                  <td>
                    {visit.counted ? (visit.durationValid ? '● Counted' : '◐ Counted, short') : `○ Not counted (${visit.reasons.join(', ').replaceAll('_', ' ')})`}
                  </td>
                  <td>
                    {(flagByVisit.get(visit.id) ?? []).map((flag) => (
                      <Link key={flag.id} to={`/mentor-admin/flags?flag=${flag.id}`} className="tag">
                        {flag.ruleCode} · {flag.status.replace('_', ' ')}
                      </Link>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid--halves">
        <Card title="Trend — last 6 periods">
          <TrendLine title="Overall score" points={chronological.map((point) => ({ label: formatPeriod(point.startDate, point.endDate).split(' – ')[0]!, value: point.overall }))} />
        </Card>
        <Card title="Score history">
          <ol className="timeline">
            {data.events.map((event, index) => (
              <li key={index}>
                <strong>{event.event_type}</strong> · {formatRelativeTime(event.created_at)}
                {event.actor ? ` · ${event.actor}` : ''}
                {event.reason && <span className="muted block">{event.reason}</span>}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Audit trail">
        {data.evidence.flags.length === 0 ? (
          <EmptyState icon="●" title="No flags in this period" />
        ) : (
          <ul className="timeline">
            {data.evidence.flags.map((flag) => (
              <li key={flag.id}>
                <Link to={`/mentor-admin/flags?flag=${flag.id}`}>
                  {flag.ruleCode} · {flag.kind} · {flag.status.replace('_', ' ')}
                </Link>
                <span className="muted block">{flag.why}</span>
                {data.reviews.filter((review) => review.flag_id === flag.id).map((review) => (
                  <span key={review.id} className="tiny block">
                    {review.decision.replace('_', ' ')} by {review.reviewer ?? 'unknown'} · {formatRelativeTime(review.decided_at)}
                    {review.reason_code ? ` · ${review.reason_code.replaceAll('_', ' ')}` : ''}
                    {review.note ? ` — ${review.note}` : ''}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {can('mentor_score:recalculate') && <RecalculateCard mentorId={data.mentor.id} periodId={data.period.id} onDone={() => void refetch()} />}
    </div>
  );
}

/** Applies confirmed late findings through an audited recalculation; the previous score is kept. */
function RecalculateCard({ mentorId, periodId, onDone }: { mentorId: string; periodId: string; onDone: () => void }): JSX.Element {
  const [reason, setReason] = useState('');
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.post<{ version: number; before: { overall: number | null }; after: { overall: number | null } }>('/admin/recalculate', { periodId, mentorId, reason }),
    onSuccess: (result) => {
      notify(`Recalculated: ${oneDecimal(result.before.overall)} → ${oneDecimal(result.after.overall)} (revision ${result.version})`, 'success');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['mentor-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['mentor'] });
      onDone();
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Recalculation failed', 'error'),
  });

  return (
    <Card title="Apply a correction">
      <p className="muted">
        Re-scores this mentor for this period using its frozen configuration and any issues confirmed since it closed. The
        mentor's report card then shows an “Updated” note with this reason. The previous score is kept in the history.
      </p>
      <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
        <Field label="Reason (shown to the mentor)" htmlFor="recalc-reason" hint="At least 5 characters.">
          <Textarea id="recalc-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        </Field>
        <div>
          <Button disabled={reason.trim().length < 5 || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Recalculating…' : 'Recalculate this score'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function exportCsv(data: Drilldown): void {
  const cell = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [
    ['Mentor', data.mentor.name],
    ['Period', `${data.period.startDate} to ${data.period.endDate}`],
    ['Configuration version', data.configVersion],
    ['Overall', data.scores.overall],
    ['Compliance', data.scores.compliance],
    ['Data reliability', data.scores.reliability],
    [],
    ['Metric', 'Numerator', 'Denominator', 'Value', 'Points', 'Applicable'],
    ...data.drivers.map((d) => [d.code, d.numerator, d.denominator, d.value, d.points, d.applicable ? 'yes' : 'no']),
    [],
    ['School', 'Started', 'Counted', 'Minutes', 'Reasons'],
    ...data.evidence.visits.map((v) => [v.schoolId, v.startedAt, v.counted ? 'yes' : 'no', v.durationMinutes === null ? '' : Math.round(v.durationMinutes), v.reasons.join('; ')]),
  ];
  const blob = new Blob([`﻿${lines.map((line) => line.map(cell).join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mentor-score-${data.mentor.name.replaceAll(/\s+/g, '-').toLowerCase()}-${data.period.startDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
