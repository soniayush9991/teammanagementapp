import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SCORE_CONFIG, validateScoreConfig, type MentorScoreConfig } from '@teamspace/shared';
import { api, ApiError } from '../../api/client';
import { useConfigVersions, usePeriods, type ConfigPreview, type ConfigVersion } from '../../api/mentorAdmin';
import { Badge, Button, Card, ErrorBlock, Field, Input, LoadingBlock, Select, formatRelativeTime } from '../../components/ui';
import { formatDay, formatPeriod } from '../../components/mentor/format';
import { PeriodSelect, oneDecimal } from '../../components/mentorAdmin/parts';
import { useToast } from '../../state/ToastContext';

/* The form works in percent and whole units; the API stores fractions. */
interface Form {
  periodDays: number;
  compliance: number;
  reliability: number;
  coverage: number;
  duration: number;
  spot: number;
  inflation: number;
  contradiction: number;
  minValidDurationMinutes: number;
  durationCapMinutes: number;
  minVisits: number;
  minChecks: number;
  recognitionQualityFloor: number;
  benchmarkMinCohort: number;
  duplicateWindowMinutes: number;
  requireVerifiedLocation: boolean;
  lateConfirmationPolicy: 'carryover' | 'recalculate';
  defaultRoleTarget: number;
  roleTargets: { role: string; target: number }[];
}

const pct = (fraction: number): number => Math.round(fraction * 10000) / 100;
const frac = (percent: number): number => Math.round(percent * 100) / 10000;

function toForm(config: MentorScoreConfig): Form {
  return {
    periodDays: config.periodDays,
    compliance: pct(config.componentWeights.compliance),
    reliability: pct(config.componentWeights.reliability),
    coverage: pct(config.complianceWeights.visit_coverage),
    duration: pct(config.complianceWeights.duration_validity),
    spot: pct(config.complianceWeights.spot_completion),
    inflation: pct(config.reliabilityWeights.inflation_reliability),
    contradiction: pct(config.reliabilityWeights.contradiction_reliability),
    minValidDurationMinutes: config.minValidDurationMinutes,
    durationCapMinutes: config.durationCapMinutes,
    minVisits: config.minEvidence.eligibleVisits,
    minChecks: config.minEvidence.qualityChecks,
    recognitionQualityFloor: config.recognitionQualityFloor,
    benchmarkMinCohort: config.benchmarkMinCohort,
    duplicateWindowMinutes: config.duplicateWindowMinutes,
    requireVerifiedLocation: config.requireVerifiedLocation,
    lateConfirmationPolicy: config.lateConfirmationPolicy,
    defaultRoleTarget: config.defaultRoleTarget,
    roleTargets: Object.entries(config.roleTargets).map(([role, target]) => ({ role, target })),
  };
}

function toConfig(form: Form): MentorScoreConfig {
  return {
    periodDays: form.periodDays,
    componentWeights: { compliance: frac(form.compliance), reliability: frac(form.reliability) },
    complianceWeights: { visit_coverage: frac(form.coverage), duration_validity: frac(form.duration), spot_completion: frac(form.spot) },
    reliabilityWeights: { inflation_reliability: frac(form.inflation), contradiction_reliability: frac(form.contradiction) },
    minValidDurationMinutes: form.minValidDurationMinutes,
    durationCapMinutes: form.durationCapMinutes,
    minEvidence: { eligibleVisits: form.minVisits, qualityChecks: form.minChecks },
    recognitionQualityFloor: form.recognitionQualityFloor,
    benchmarkMinCohort: form.benchmarkMinCohort,
    lateConfirmationPolicy: form.lateConfirmationPolicy,
    roleTargets: Object.fromEntries(form.roleTargets.filter((entry) => entry.role.trim()).map((entry) => [entry.role.trim(), entry.target])),
    defaultRoleTarget: form.defaultRoleTarget,
    requireVerifiedLocation: form.requireVerifiedLocation,
    duplicateWindowMinutes: form.duplicateWindowMinutes,
  };
}

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** A5: edit, preview and publish scoring configuration; operate scoring periods. */
export function ConfigPage(): JSX.Element {
  const versions = useConfigVersions(true);
  const periods = usePeriods();

  if (versions.isPending || periods.isPending) return <LoadingBlock rows={6} label="Loading configuration" />;
  if (versions.error || !versions.data) return <ErrorBlock error={versions.error} onRetry={() => void versions.refetch()} />;

  const latest = versions.data.items[0];
  const closed = (periods.data?.items ?? []).filter((period) => period.status === 'closed');
  const lastClosedEnd = closed.map((period) => period.end_date).sort().at(-1);
  // A new version can only apply to periods that have not closed yet.
  const earliest = lastClosedEnd ? addDays(lastClosedEnd, 1) : '2020-01-01';

  return (
    <div className="stack">
      {/* Remounted when a version is loaded, so the form resets cleanly. */}
      <ConfigEditor key={latest?.id ?? 'defaults'} base={latest} versions={versions.data.items} earliest={earliest} hasClosed={closed.length > 0} />
      <PeriodsCard />
    </div>
  );
}

function ConfigEditor({ base, versions, earliest, hasClosed }: { base: ConfigVersion | undefined; versions: ConfigVersion[]; earliest: string; hasClosed: boolean }): JSX.Element {
  const [form, setForm] = useState<Form>(() => toForm(base?.config ?? DEFAULT_SCORE_CONFIG));
  const [effectiveFrom, setEffectiveFrom] = useState(earliest);
  const [note, setNote] = useState('');
  const [previewPeriod, setPreviewPeriod] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const set = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setConfirming(false);
  };
  const config = useMemo(() => toConfig(form), [form]);
  const problems = useMemo(() => validateScoreConfig(config), [config]);
  const dateProblem = effectiveFrom < earliest ? `Effective date must be ${formatDay(earliest)} or later — closed periods keep the version they were scored with.` : null;

  const preview = useMutation({
    mutationFn: () => api.post<ConfigPreview>('/admin/config/preview', { periodId: previewPeriod, config }),
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Preview failed', 'error'),
  });
  const publish = useMutation({
    mutationFn: () => api.post<{ version: number }>('/admin/config/publish', { config, effectiveFrom, note: note.trim() || undefined }),
    onSuccess: (result) => {
      notify(`Version ${result.version} published`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['mentor-admin'] });
    },
    onError: (error) => notify(error instanceof ApiError ? error.message : 'Publishing failed', 'error'),
  });

  const sum = (...values: number[]): number => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
  const SumNote = ({ total }: { total: number }): JSX.Element => (
    <span className={total === 100 ? 'sum sum--ok' : 'sum sum--bad'}>{total === 100 ? '● Adds to 100%' : `▲ Adds to ${total}% — must be 100%`}</span>
  );

  return (
    <>
      <Card title={base ? `Editing from version ${base.version}` : 'No configuration published yet — starting from the defaults'}>
        <p className="muted">
          Every publish creates a new, permanent version. Closed periods are never re-scored with it; it applies to periods that start on or after its effective date.
        </p>
      </Card>

      <div className="grid grid--halves">
        <Card title="Weights">
          <div className="stack">
            <fieldset className="fieldset">
              <legend>Final score</legend>
              <NumField label="Compliance" value={form.compliance} onChange={(v) => set('compliance', v)} suffix="%" />
              <NumField label="Data reliability" value={form.reliability} onChange={(v) => set('reliability', v)} suffix="%" />
              <SumNote total={sum(form.compliance, form.reliability)} />
            </fieldset>
            <fieldset className="fieldset">
              <legend>Inside compliance</legend>
              <NumField label="Visit coverage" value={form.coverage} onChange={(v) => set('coverage', v)} suffix="%" />
              <NumField label="Visit duration" value={form.duration} onChange={(v) => set('duration', v)} suffix="%" />
              <NumField label="Spot assessments" value={form.spot} onChange={(v) => set('spot', v)} suffix="%" />
              <SumNote total={sum(form.coverage, form.duration, form.spot)} />
            </fieldset>
            <fieldset className="fieldset">
              <legend>Inside data reliability</legend>
              <NumField label="Inflation" value={form.inflation} onChange={(v) => set('inflation', v)} suffix="%" />
              <NumField label="Contradiction" value={form.contradiction} onChange={(v) => set('contradiction', v)} suffix="%" />
              <SumNote total={sum(form.inflation, form.contradiction)} />
            </fieldset>
          </div>
        </Card>

        <Card title="Thresholds">
          <div className="stack">
            <NumField label="Scoring period length" value={form.periodDays} onChange={(v) => set('periodDays', v)} suffix="days" />
            <NumField label="Minimum valid visit duration" value={form.minValidDurationMinutes} onChange={(v) => set('minValidDurationMinutes', v)} suffix="min" />
            <NumField label="Duration scoring cap" value={form.durationCapMinutes} onChange={(v) => set('durationCapMinutes', v)} suffix="min" />
            <NumField label="Minimum counted visits for a final score" value={form.minVisits} onChange={(v) => set('minVisits', v)} />
            <NumField label="Minimum quality checks for a final score" value={form.minChecks} onChange={(v) => set('minChecks', v)} />
            <NumField label="Recognition reliability floor" value={form.recognitionQualityFloor} onChange={(v) => set('recognitionQualityFloor', v)} suffix="/100" />
            <NumField label="Smallest cohort that shows a benchmark" value={form.benchmarkMinCohort} onChange={(v) => set('benchmarkMinCohort', v)} suffix="mentors" />
            <NumField label="Duplicate-visit window" value={form.duplicateWindowMinutes} onChange={(v) => set('duplicateWindowMinutes', v)} suffix="min" />
            <label className="check">
              <input type="checkbox" checked={form.requireVerifiedLocation} onChange={(e) => set('requireVerifiedLocation', e.target.checked)} /> Require a verified location (accepted GPS exceptions still count)
            </label>
            <Field label="A flag confirmed after its period closed" htmlFor="late-policy">
              <Select id="late-policy" value={form.lateConfirmationPolicy} onChange={(e) => set('lateConfirmationPolicy', e.target.value as Form['lateConfirmationPolicy'])}>
                <option value="carryover">Carry over into the next period</option>
                <option value="recalculate">Only change the score through a recalculation</option>
              </Select>
            </Field>
          </div>
        </Card>
      </div>

      <Card title="Visit targets by role">
        <p className="muted">Expected visits per full period. Prorated for days a mentor was active, minus approved leave, training and declared outages.</p>
        <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
          {form.roleTargets.map((entry, index) => (
            <div key={index} className="row row--wrap role-row">
              <Input className="input role-row__name" aria-label="Role name" value={entry.role} placeholder="Role" onChange={(e) => set('roleTargets', form.roleTargets.map((item, i) => (i === index ? { ...item, role: e.target.value } : item)))} />
              <Input className="input role-row__target" aria-label={`Visits per period for ${entry.role || 'this role'}`} type="number" min={0} value={entry.target} onChange={(e) => set('roleTargets', form.roleTargets.map((item, i) => (i === index ? { ...item, target: Number(e.target.value) } : item)))} />
              <Button variant="ghost" size="sm" onClick={() => set('roleTargets', form.roleTargets.filter((_, i) => i !== index))}>Remove</Button>
            </div>
          ))}
          <div className="row row--wrap">
            <Button variant="secondary" size="sm" onClick={() => set('roleTargets', [...form.roleTargets, { role: '', target: form.defaultRoleTarget }])}>Add a role</Button>
            <NumField label="Target for any other role" value={form.defaultRoleTarget} onChange={(v) => set('defaultRoleTarget', v)} />
          </div>
        </div>
      </Card>

      <Card title="Preview">
        <p className="muted">Re-scores the frozen evidence of a closed period under this draft. Nothing is saved.</p>
        {!hasClosed ? (
          <p className="tiny">Preview needs at least one closed period.</p>
        ) : (
          <div className="row row--wrap" style={{ marginTop: 'var(--space-3)' }}>
            <PeriodSelect value={previewPeriod} onChange={setPreviewPeriod} />
            <Button variant="secondary" disabled={!previewPeriod || problems.length > 0 || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? 'Running…' : 'Run preview'}
            </Button>
          </div>
        )}
        {preview.data && <PreviewResult result={preview.data} />}
      </Card>

      <Card title="Publish">
        <div className="stack">
          {problems.length > 0 && (
            <ul className="problems" role="alert">
              {problems.map((problem) => <li key={problem}>▲ {problem}</li>)}
            </ul>
          )}
          <Field label="Effective from" htmlFor="effective-from" error={dateProblem ?? undefined} hint="Applies to scoring periods starting on or after this date.">
            <Input id="effective-from" type="date" value={effectiveFrom} min={earliest} onChange={(e) => { setEffectiveFrom(e.target.value); setConfirming(false); }} />
          </Field>
          <Field label="Note (optional)" htmlFor="config-note">
            <Input id="config-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What changed and why" />
          </Field>
          <div className="row row--wrap">
            {!confirming ? (
              <Button disabled={problems.length > 0 || Boolean(dateProblem)} onClick={() => setConfirming(true)}>Publish new version…</Button>
            ) : (
              <>
                <span>Publish version {(versions[0]?.version ?? 0) + 1}, effective {formatDay(effectiveFrom)}? This cannot be edited afterwards.</span>
                <Button disabled={publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? 'Publishing…' : 'Yes, publish'}</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card title="Published versions" flush>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Effective from</th>
                <th scope="col">Weights (C / R)</th>
                <th scope="col">Published</th>
                <th scope="col">Note</th>
                <th scope="col"><span className="sr-only">Load</span></th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <th scope="row">v{version.version}</th>
                  <td>{formatDay(version.effectiveFrom)}</td>
                  <td>{pct(version.config.componentWeights.compliance)} / {pct(version.config.componentWeights.reliability)}</td>
                  <td>{formatRelativeTime(version.createdAt)}{version.createdBy ? ` · ${version.createdBy}` : ''}</td>
                  <td>{version.note ?? '—'}</td>
                  <td><Button variant="ghost" size="sm" onClick={() => { setForm(toForm(version.config)); setConfirming(false); }}>Load into form</Button></td>
                </tr>
              ))}
              {versions.length === 0 && <tr><td colSpan={6} className="muted">Nothing published yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function NumField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (value: number) => void; suffix?: string }): JSX.Element {
  const id = `num-${label.replaceAll(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="numfield">
      <label htmlFor={id}>{label}</label>
      <span className="numfield__input">
        <Input id={id} type="number" step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
        {suffix && <span className="muted">{suffix}</span>}
      </span>
    </div>
  );
}

function PreviewResult({ result }: { result: ConfigPreview }): JSX.Element {
  const moved = result.mentors.filter((mentor) => mentor.change !== null && mentor.change !== 0).length;
  const rows: [string, number | null, number | null][] = [
    ['Mentors scored', result.before.count, result.after.count],
    ['Median', result.before.median, result.after.median],
    ['Lower quartile', result.before.q1, result.after.q1],
    ['Upper quartile', result.before.q3, result.after.q3],
    ['Mean', result.before.mean, result.after.mean],
  ];
  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Overall score</th>
            <th scope="col" className="th--numeric">Version {result.baselineConfigVersion}</th>
            <th scope="col" className="th--numeric">This draft</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="td--numeric">{oneDecimal(before)}</td>
              <td className="td--numeric">{oneDecimal(after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 'var(--space-3)' }}>
        <Badge tone="accent">{moved} of {result.mentors.length} scores would change</Badge>{' '}
        <Badge>{result.statusChanges} would change status</Badge>
      </p>
    </div>
  );
}

/** Opening, closing and publishing periods. Needed to operate scoring, so it lives with configuration. */
function PeriodsCard(): JSX.Element {
  const { data, isPending, error, refetch } = usePeriods();
  const [start, setStart] = useState('');
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['mentor-admin'] });
  const onError = (e: unknown): void => notify(e instanceof ApiError ? e.message : 'That failed', 'error');

  const create = useMutation({ mutationFn: () => api.post('/admin/periods', { startDate: start }), onSuccess: () => { notify('Period created', 'success'); setStart(''); refresh(); }, onError });
  const close = useMutation({ mutationFn: (id: string) => api.post<{ scored: number }>(`/admin/periods/${id}/close`), onSuccess: (r) => { notify(`Period closed, ${r.scored} mentors scored`, 'success'); refresh(); }, onError });
  const publish = useMutation({ mutationFn: (id: string) => api.post(`/admin/periods/${id}/publish`), onSuccess: () => { notify('Report cards published to mentors', 'success'); refresh(); }, onError });

  return (
    <Card title="Scoring periods" flush>
      {isPending && <div style={{ padding: 'var(--space-4)' }}><LoadingBlock rows={3} label="Loading periods" /></div>}
      {error && <ErrorBlock error={error} onRetry={() => void refetch()} />}
      {data && (
        <>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Status</th>
                  <th scope="col">Mentors see it</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((period) => (
                  <tr key={period.id}>
                    <th scope="row">{formatPeriod(period.start_date, period.end_date)}</th>
                    <td>{period.status === 'open' ? '◐ Open' : '● Closed'}</td>
                    <td>{period.status === 'closed' ? (period.published_at ? 'Yes' : 'No — shadow mode') : '—'}</td>
                    <td className="row-actions">
                      {period.status === 'open' && <Button size="sm" variant="secondary" disabled={close.isPending} onClick={() => close.mutate(period.id)}>Close and score</Button>}
                      {period.status === 'closed' && !period.published_at && <Button size="sm" variant="secondary" disabled={publish.isPending} onClick={() => publish.mutate(period.id)}>Publish to mentors</Button>}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && <tr><td colSpan={4} className="muted">No periods yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="row row--wrap" style={{ padding: 'var(--space-4)' }}>
            <Field label="New period starts on" htmlFor="new-period">
              <Input id="new-period" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Button variant="secondary" disabled={!start || create.isPending} onClick={() => create.mutate()}>Create period</Button>
          </div>
          <p className="tiny" style={{ padding: '0 var(--space-4) var(--space-4)' }}>A period can only be closed once it has ended. Its length comes from the configuration in force on its start date.</p>
        </>
      )}
    </Card>
  );
}
