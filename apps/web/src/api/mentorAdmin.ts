import { useQuery } from '@tanstack/react-query';
import type { MentorScoreConfig } from '@teamspace/shared';
import { api, qs } from './client';
import type { ScoreStatus } from './mentor';

/** Response shapes of the reviewer/admin endpoints under /api/v1/admin. */

export interface AdminPeriod {
  id: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  config_version_id: string | null;
  closed_at: string | null;
  published_at: string | null;
}

export interface Distribution {
  count: number;
  min: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  max: number | null;
  mean: number | null;
}

export interface ScoreListItem {
  mentorId: string;
  name: string;
  role: string;
  district: string | null;
  block: string | null;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  status: ScoreStatus;
  delta: number | null;
  flags: { flagged: number; confirmed: number };
  visits: { valid: number; expected: number };
  revision: number;
}

export interface ScoreList {
  period: { id: string; startDate: string; endDate: string; status: string; published: boolean };
  summary: {
    mentors: number;
    averageScore: number | null;
    medianScore: number | null;
    percentFinal: number | null;
    percentProvisional: number | null;
    validVisitCoverage: number | null;
    confirmedIntegrityIssueRate: number | null;
    distribution: Distribution;
    histogram: { label: string; count: number }[];
    compliance: Distribution;
    reliability: Distribution;
  };
  items: ScoreListItem[];
  total: number;
}

export interface KindCounts {
  flagged: number;
  confirmed: number;
  dismissed: number;
  checks: number;
  rate: number | null;
}

export interface TrendItem {
  periodId: string;
  startDate: string;
  endDate: string;
  mentors: number;
  scored: number;
  percentFinal: number | null;
  compliance: number | null;
  reliability: number | null;
  overall: number | null;
  coverage: number | null;
  inflation: KindCounts;
  contradiction: KindCounts;
}

export interface FilterOptions {
  districts: string[];
  blocks: { block: string; district: string | null }[];
  roles: string[];
}

export interface FlagListItem {
  id: string;
  mentor_id: string;
  mentor_name: string;
  district: string | null;
  block: string | null;
  visit_id: string;
  kind: 'inflation' | 'contradiction';
  rule_code: string;
  severity: 'low' | 'medium' | 'high';
  status: 'new' | 'in_review' | 'confirmed' | 'dismissed' | 'escalated';
  explanation: string;
  repeat_count: number;
  age_days: number;
  school_id: string;
  started_at: string;
}

export interface FlagDetail {
  flag: {
    id: string;
    kind: string;
    ruleCode: string;
    severity: string;
    status: FlagListItem['status'];
    explanation: string;
    evidence: Record<string, unknown>;
    createdAt: string;
    confirmedAt: string | null;
    resolvedAt: string | null;
    lateConfirmed: boolean;
    repeatCount: number;
    canReview: boolean;
  };
  mentor: { id: string; name: string; role: string | null; district: string | null; block: string | null };
  visit: {
    id: string;
    school_id: string;
    visit_type: string;
    started_at: string;
    ended_at: string;
    submitted_at: string;
    completed: boolean;
    assignment_valid: boolean;
    location_status: string;
    spot_applicable: number;
    spot_completed: number;
    inflation_checks: number;
    consistency_checks: number;
    duration_minutes: number;
  };
  otherFlagsOnVisit: { id: string; kind: string; rule_code: string; status: string }[];
  reviews: {
    id: string;
    decision: string;
    from_status: string;
    to_status: string;
    reason_code: string | null;
    note: string | null;
    decided_at: string;
    reviewer: string | null;
  }[];
}

export interface DrilldownMetric {
  code: string;
  numerator: number;
  denominator: number;
  value: number | null;
  applicable: boolean;
  weight: number;
  effectiveWeight: number;
  points: number;
  ruleVersion: number;
}

export interface Drilldown {
  mentor: { id: string; name: string; role: string; district: string | null; block: string | null; activeFrom: string | null; activeTo: string | null };
  period: { id: string; startDate: string; endDate: string };
  scores: { overall: number | null; compliance: number | null; reliability: number | null; status: ScoreStatus; revision: number };
  configVersion: number;
  drivers: DrilldownMetric[];
  evidence: {
    visits: { id: string; schoolId: string; startedAt: string; counted: boolean; durationMinutes: number | null; durationValid: boolean; reasons: string[] }[];
    flags: { id: string; visitId: string; kind: string; status: string; why: string; ruleCode?: string; severity?: string }[];
  };
  reviews: { id: string; flag_id: string; decision: string; from_status: string; to_status: string; reason_code: string | null; note: string | null; decided_at: string; reviewer: string | null }[];
  events: { event_type: string; before_value: Record<string, unknown> | null; after_value: Record<string, unknown> | null; reason: string | null; created_at: string; actor: string | null }[];
  trend: { periodId: string; startDate: string; endDate: string; overall: number | null; compliance: number | null; reliability: number | null; status: ScoreStatus; delta: number | null; revision: number }[];
}

export interface BenchmarkList {
  period: { id: string; startDate: string; endDate: string; status: string };
  minCohortSize: number | null;
  items: {
    id: string;
    geography: string;
    role: string;
    statistic: string;
    value: number | null;
    cohortSize: number;
    suppressed: boolean;
    capMethod: string;
    dataWindow: string[] | null;
    calculatedAt: string;
    members: { id: string; name: string }[] | null;
  }[];
}

export interface Recognition {
  period: { id: string; startDate: string; endDate: string; published: boolean };
  qualityFloor: number;
  mentorsConsidered: number;
  eligible: number;
  notEligible: { notFinal: number; openReview: number; belowQualityFloor: number };
  categories: { category: string; label: string; winners: { mentorId: string; name: string; district: string | null; value: number | null }[] }[];
}

export interface ConfigVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  config: MentorScoreConfig;
}

export interface ConfigPreview {
  periodId: string;
  baselineConfigVersion: number;
  before: Distribution;
  after: Distribution;
  statusChanges: number;
  mentors: { mentorId: string; before: { overall: number | null; status: string }; after: { overall: number | null; status: string }; change: number | null }[];
}

export type Filters = { period?: string; district?: string; block?: string; role?: string; status?: string };

const STALE = 30_000;

export const usePeriods = () =>
  useQuery({ queryKey: ['mentor-admin', 'periods'], queryFn: () => api.get<{ items: AdminPeriod[] }>('/admin/periods'), staleTime: STALE });

export const useFilterOptions = () =>
  useQuery({ queryKey: ['mentor-admin', 'filters'], queryFn: () => api.get<FilterOptions>('/admin/mentor-filters'), staleTime: 5 * 60_000 });

export const useScoreList = (filters: Filters) =>
  useQuery({
    queryKey: ['mentor-admin', 'scores', filters],
    queryFn: () =>
      api.get<ScoreList>(`/admin/scores${qs({ period_id: filters.period, district: filters.district, block: filters.block, role: filters.role, status: filters.status, limit: 200 })}`),
    staleTime: STALE,
  });

export const useTrend = (filters: Filters, periods = 6) =>
  useQuery({
    queryKey: ['mentor-admin', 'trend', filters.district, filters.block, filters.role, periods],
    queryFn: () => api.get<{ items: TrendItem[] }>(`/admin/trend${qs({ periods, district: filters.district, block: filters.block, role: filters.role })}`),
    staleTime: STALE,
  });

export const useDrilldown = (mentorId: string | undefined, period: string | undefined) =>
  useQuery({
    queryKey: ['mentor-admin', 'drilldown', mentorId, period],
    queryFn: () => api.get<Drilldown>(`/admin/scores/${mentorId}${qs({ period_id: period })}`),
    enabled: Boolean(mentorId),
  });

export const useBenchmarks = (period: string | undefined) =>
  useQuery({
    queryKey: ['mentor-admin', 'benchmarks', period],
    queryFn: () => api.get<BenchmarkList>(`/admin/benchmarks${qs({ period_id: period })}`),
    staleTime: STALE,
  });

export const useRecognition = (period: string | undefined) =>
  useQuery({
    queryKey: ['mentor-admin', 'recognition', period],
    queryFn: () => api.get<Recognition>(`/admin/recognition${qs({ period_id: period })}`),
    staleTime: STALE,
  });

export const useConfigVersions = (enabled: boolean) =>
  useQuery({
    queryKey: ['mentor-admin', 'config-versions'],
    queryFn: () => api.get<{ items: ConfigVersion[] }>('/admin/config/versions'),
    enabled,
  });
