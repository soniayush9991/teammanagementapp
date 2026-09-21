import type { UtilizationBand } from './domain.js';

export const UTILIZATION_THRESHOLDS = {
  /** Below this a person is flagged as having spare bandwidth. */
  underutilized: 0.6,
  /** At or above this the person is amber: nearly full. */
  nearCapacity: 0.85,
  /** Above 100% of capacity the person is red: over-allocated. */
  overloaded: 1.0,
} as const;

export interface CapacityInput {
  /** Contracted hours for the ISO week, e.g. 40. */
  weeklyCapacityHours: number;
  /** Hours lost to approved leave and public holidays inside the week. */
  leaveHours: number;
  /** Sum of remaining effort on open tasks landing in the week. */
  plannedHours: number;
  /** Hours actually logged against tasks in the week. */
  loggedHours?: number;
}

export interface CapacitySnapshot {
  weeklyCapacityHours: number;
  leaveHours: number;
  /** Capacity after leave is deducted; never negative. */
  effectiveCapacityHours: number;
  plannedHours: number;
  loggedHours: number;
  /** effectiveCapacity - planned, clamped at 0. */
  availableHours: number;
  /** planned - effectiveCapacity when planned exceeds capacity, else 0. */
  overAllocationHours: number;
  /** planned / effectiveCapacity, 0 when there is no effective capacity. */
  utilization: number;
  band: UtilizationBand;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function utilizationBand(utilization: number): UtilizationBand {
  if (utilization > UTILIZATION_THRESHOLDS.overloaded) return 'overloaded';
  if (utilization >= UTILIZATION_THRESHOLDS.nearCapacity) return 'near_capacity';
  if (utilization < UTILIZATION_THRESHOLDS.underutilized) return 'underutilized';
  return 'healthy';
}

/**
 * Single source of truth for bandwidth math. The API uses it to build
 * dashboards and reports; the web client uses it for optimistic previews
 * while a manager drags a task between people.
 */
export function computeCapacity(input: CapacityInput): CapacitySnapshot {
  const weeklyCapacityHours = Math.max(0, input.weeklyCapacityHours);
  const leaveHours = Math.min(Math.max(0, input.leaveHours), weeklyCapacityHours);
  const plannedHours = Math.max(0, input.plannedHours);
  const loggedHours = Math.max(0, input.loggedHours ?? 0);
  const effectiveCapacityHours = Math.max(0, weeklyCapacityHours - leaveHours);

  const availableHours = Math.max(0, effectiveCapacityHours - plannedHours);
  const overAllocationHours = Math.max(0, plannedHours - effectiveCapacityHours);
  // A person on full leave with work still planned is maximally overloaded
  // rather than dividing by zero.
  const utilization =
    effectiveCapacityHours === 0 ? (plannedHours > 0 ? Infinity : 0) : plannedHours / effectiveCapacityHours;

  return {
    weeklyCapacityHours: round2(weeklyCapacityHours),
    leaveHours: round2(leaveHours),
    effectiveCapacityHours: round2(effectiveCapacityHours),
    plannedHours: round2(plannedHours),
    loggedHours: round2(loggedHours),
    availableHours: round2(availableHours),
    overAllocationHours: round2(overAllocationHours),
    utilization: Number.isFinite(utilization) ? round2(utilization) : Infinity,
    band: utilizationBand(utilization),
  };
}

export interface TeamCapacityRollup {
  totalCapacityHours: number;
  totalEffectiveCapacityHours: number;
  totalPlannedHours: number;
  totalAvailableHours: number;
  totalOverAllocationHours: number;
  utilization: number;
  overloadedCount: number;
  underutilizedCount: number;
  memberCount: number;
}

export function rollupTeamCapacity(snapshots: readonly CapacitySnapshot[]): TeamCapacityRollup {
  const totals = snapshots.reduce(
    (acc, snapshot) => {
      acc.capacity += snapshot.weeklyCapacityHours;
      acc.effective += snapshot.effectiveCapacityHours;
      acc.planned += snapshot.plannedHours;
      acc.available += snapshot.availableHours;
      acc.over += snapshot.overAllocationHours;
      if (snapshot.band === 'overloaded') acc.overloaded += 1;
      if (snapshot.band === 'underutilized') acc.under += 1;
      return acc;
    },
    { capacity: 0, effective: 0, planned: 0, available: 0, over: 0, overloaded: 0, under: 0 },
  );

  return {
    totalCapacityHours: round2(totals.capacity),
    totalEffectiveCapacityHours: round2(totals.effective),
    totalPlannedHours: round2(totals.planned),
    totalAvailableHours: round2(totals.available),
    totalOverAllocationHours: round2(totals.over),
    utilization: totals.effective === 0 ? 0 : round2(totals.planned / totals.effective),
    overloadedCount: totals.overloaded,
    underutilizedCount: totals.under,
    memberCount: snapshots.length,
  };
}

export interface AssigneeCandidate {
  userId: string;
  displayName: string;
  skills: readonly string[];
  capacity: CapacitySnapshot;
  /** Open tasks already on the person's plate, used as a tie breaker. */
  openTaskCount: number;
}

export interface AssigneeRecommendation {
  userId: string;
  displayName: string;
  /** 0..1, higher is a better fit. */
  score: number;
  skillMatch: number;
  availabilityScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  band: UtilizationBand;
  /** Utilization the person would land on if this task were assigned to them. */
  projectedUtilization: number;
}

export interface RecommendationOptions {
  /** Skills the task needs; empty means availability decides alone. */
  requiredSkills?: readonly string[];
  /** Remaining effort of the task being placed. */
  estimatedHours?: number;
  /** Weight of skill fit vs. availability. Defaults to a 50/50 split. */
  skillWeight?: number;
}

function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}

/**
 * Ranks candidates for an assignment by blending skill overlap with the
 * bandwidth they would have left afterwards. Deterministic: ties break on
 * open task count, then name, so the same inputs always rank the same way.
 */
export function recommendAssignees(
  candidates: readonly AssigneeCandidate[],
  options: RecommendationOptions = {},
): AssigneeRecommendation[] {
  const required = (options.requiredSkills ?? []).map(normalizeSkill).filter(Boolean);
  const estimatedHours = Math.max(0, options.estimatedHours ?? 0);
  const skillWeight = required.length === 0 ? 0 : Math.min(1, Math.max(0, options.skillWeight ?? 0.5));

  const scored = candidates.map((candidate) => {
    const candidateSkills = new Set(candidate.skills.map(normalizeSkill));
    const matchedSkills = required.filter((skill) => candidateSkills.has(skill));
    const missingSkills = required.filter((skill) => !candidateSkills.has(skill));
    const skillMatch = required.length === 0 ? 1 : matchedSkills.length / required.length;

    const effective = candidate.capacity.effectiveCapacityHours;
    const projectedPlanned = candidate.capacity.plannedHours + estimatedHours;
    const projectedUtilization = effective === 0 ? Infinity : projectedPlanned / effective;
    // Availability peaks at 1 for someone who would still be comfortably
    // below capacity and decays to 0 once the task would tip them over.
    const availabilityScore = Number.isFinite(projectedUtilization)
      ? Math.max(0, Math.min(1, 1 - projectedUtilization))
      : 0;

    const score = skillWeight * skillMatch + (1 - skillWeight) * availabilityScore;

    return {
      userId: candidate.userId,
      displayName: candidate.displayName,
      score: round2(score),
      skillMatch: round2(skillMatch),
      availabilityScore: round2(availabilityScore),
      matchedSkills,
      missingSkills,
      band: utilizationBand(projectedUtilization),
      projectedUtilization: Number.isFinite(projectedUtilization) ? round2(projectedUtilization) : Infinity,
      openTaskCount: candidate.openTaskCount,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.openTaskCount !== b.openTaskCount) return a.openTaskCount - b.openTaskCount;
    return a.displayName.localeCompare(b.displayName);
  });

  return scored.map(({ openTaskCount: _openTaskCount, ...recommendation }) => recommendation);
}
