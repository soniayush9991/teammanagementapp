import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';

/** Response shapes of /api/v1/mentor/*. Kept next to the hooks that fetch them. */

export type ScoreStatus = 'final' | 'provisional' | 'insufficient_data';

export type MetricCode =
  | 'visit_coverage'
  | 'duration_validity'
  | 'spot_completion'
  | 'inflation_reliability'
  | 'contradiction_reliability';

export interface MentorMetric {
  code: MetricCode;
  numerator: number;
  denominator: number;
  /** 0-100, null when not applicable. */
  value: number | null;
  applicable: boolean;
  weight: number;
  effectiveWeight: number;
  points: number;
}

export interface TrendPoint {
  periodId: string;
  startDate: string;
  endDate: string;
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  status: ScoreStatus;
  delta: number | null;
  revision: number;
}

export interface Nudge {
  code: string;
  params: Record<string, number>;
  message: string;
}

export interface ReportCard {
  period: { id: string; startDate: string; endDate: string };
  status: ScoreStatus;
  statusReasons: string[];
  overall: number | null;
  compliance: number | null;
  reliability: number | null;
  underReview: boolean;
  previousOverall: number | null;
  delta: number | null;
  updated: { at: string; reason: string | null; revision: number } | null;
  metrics: MentorMetric[];
  trend: TrendPoint[];
  benchmark: { label: string; value: number | null; suppressed: boolean } | null;
  primaryAction: Nudge | null;
  nudges: Nudge[];
  definitions: string;
}

export interface EvidenceVisit {
  id: string;
  schoolId: string;
  startedAt: string;
  endedAt: string;
  counted: boolean;
  durationMinutes: number | null;
  durationValid: boolean;
  spotApplicable: number;
  spotCompleted: number;
  inflationChecks: number;
  consistencyChecks: number;
  reasons: string[];
}

export interface EvidenceFlag {
  id: string;
  visitId: string;
  kind: 'inflation' | 'contradiction';
  status: 'new' | 'in_review' | 'escalated' | 'confirmed' | 'dismissed';
  affectsScore: boolean;
  why: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Evidence {
  period: { id: string; startDate: string; endDate: string };
  metrics: MentorMetric[];
  exclusions: { expectedVisitsTarget: number | null; activeDays: number | null; excludedDays: number | null; note: string };
  visits: EvidenceVisit[];
  flags: EvidenceFlag[];
}

/**
 * 404 here is a normal state, not a failure: a mentor has no card until the
 * first period has been closed and published. Callers read `notReady`.
 */
export function useReportCard(periodId?: string) {
  const query = useQuery({
    queryKey: ['mentor', 'card', periodId ?? 'latest'],
    queryFn: () => api.get<ReportCard>(periodId ? `/mentor/report-card?period_id=${periodId}` : '/mentor/report-card'),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
    staleTime: 60_000,
  });
  const notReady = query.error instanceof ApiError && query.error.status === 404;
  return { ...query, notReady };
}

export function useEvidence(periodId: string | undefined) {
  return useQuery({
    queryKey: ['mentor', 'evidence', periodId],
    queryFn: () => api.get<Evidence>(`/mentor/report-card/${periodId}/evidence`),
    enabled: Boolean(periodId),
    staleTime: 60_000,
  });
}

export function useScoreHistory() {
  return useQuery({
    queryKey: ['mentor', 'history'],
    queryFn: () => api.get<{ items: TrendPoint[] }>('/mentor/history'),
    staleTime: 60_000,
  });
}
