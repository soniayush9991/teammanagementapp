import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_SCORE_CONFIG, type MentorScoreConfig } from '@teamspace/shared';
import { asyncHandler, parseBody, parseQuery, uuid } from '../../lib/http.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import { closePeriod, recalculateMentor } from './mentorScoring.calc.js';
import * as admin from './mentorScoring.admin.js';
import * as service from './mentorScoring.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const pagination = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

// ---------------------------------------------------------------------------
// Mentor-facing: /api/v1/mentor
// ---------------------------------------------------------------------------

export const mentorRouter = Router();
mentorRouter.use(authenticate);

// There is deliberately no :mentorId anywhere on these routes. The subject is
// always the caller, so another mentor's card cannot be reached by editing a
// request parameter.
mentorRouter.get(
  '/report-card',
  requirePermission('mentor_score:read_self'),
  asyncHandler(async (req, res) => {
    const { period_id } = parseQuery(z.object({ period_id: uuid.optional() }), req.query);
    res.json(await service.getReportCard(actorOf(req), period_id));
  }),
);

mentorRouter.get(
  '/report-card/:periodId/evidence',
  requirePermission('mentor_score:read_self'),
  asyncHandler(async (req, res) => {
    res.json(await service.getEvidence(actorOf(req), uuid.parse(req.params.periodId)));
  }),
);

mentorRouter.get(
  '/history',
  requirePermission('mentor_score:read_self'),
  asyncHandler(async (req, res) => {
    res.json(await service.getHistory(actorOf(req)));
  }),
);

const visitSchema = z
  .object({
    id: uuid,
    schoolId: z.string().trim().min(1).max(120),
    visitType: z.string().trim().min(1).max(60).optional(),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    completed: z.boolean().optional(),
    assignmentValid: z.boolean().optional(),
    location: z.enum(['verified', 'exception', 'unverified', 'failed']).optional(),
    isTest: z.boolean().optional(),
    spotApplicable: z.number().int().min(0).max(1000).optional(),
    spotCompleted: z.number().int().min(0).max(1000).optional(),
    inflationChecks: z.number().int().min(0).max(1000).optional(),
    consistencyChecks: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

mentorRouter.post(
  '/visits',
  requirePermission('mentor_visit:submit'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const result = await service.submitVisit(actorOf(req), parseBody(visitSchema, req.body));
    res.status(result.created ? 201 : 200).json(result);
  }),
);

// ---------------------------------------------------------------------------
// Reviewer and admin: /api/v1/admin/mentor-scoring (+ the paths in the PRD)
// ---------------------------------------------------------------------------

export const mentorAdminRouter = Router();
mentorAdminRouter.use(authenticate);

mentorAdminRouter.get(
  '/scores',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        period_id: uuid.optional(),
        district: z.string().max(120).optional(),
        block: z.string().max(120).optional(),
        role: z.string().max(60).optional(),
        status: z.enum(['final', 'provisional', 'insufficient_data']).optional(),
        ...pagination,
      }),
      req.query,
    );
    res.json(await service.listScores(actorOf(req), { ...filter, periodId: filter.period_id }));
  }),
);

mentorAdminRouter.get(
  '/scores/:mentorId',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    const { period_id } = parseQuery(z.object({ period_id: uuid.optional() }), req.query);
    res.json(await service.getMentorDrilldown(actorOf(req), uuid.parse(req.params.mentorId), period_id));
  }),
);

mentorAdminRouter.get(
  '/flags',
  requirePermission('mentor_flag:review'),
  asyncHandler(async (req, res) => {
    const filter = parseQuery(
      z.object({
        status: z.enum(['new', 'in_review', 'confirmed', 'dismissed', 'escalated']).optional(),
        district: z.string().max(120).optional(),
        block: z.string().max(120).optional(),
        mentor_id: uuid.optional(),
        kind: z.enum(['inflation', 'contradiction']).optional(),
        rule_code: z.string().max(80).optional(),
        min_age_days: z.coerce.number().min(0).max(3650).optional(),
        period_id: uuid.optional(),
        ...pagination,
      }),
      req.query,
    );
    res.json(
      await service.listFlags(actorOf(req), {
        ...filter,
        mentorId: filter.mentor_id,
        periodId: filter.period_id,
        ruleCode: filter.rule_code,
        minAgeDays: filter.min_age_days,
      }),
    );
  }),
);

mentorAdminRouter.get(
  '/flags/:id',
  requirePermission('mentor_flag:review'),
  asyncHandler(async (req, res) => {
    res.json(await admin.getFlagDetail(actorOf(req), uuid.parse(req.params.id)));
  }),
);

mentorAdminRouter.get(
  '/mentor-filters',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    res.json(await admin.getFilterOptions(actorOf(req)));
  }),
);

mentorAdminRouter.get(
  '/trend',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    const { periods, ...filter } = parseQuery(
      z.object({
        periods: z.coerce.number().int().min(1).max(12).default(6),
        district: z.string().max(120).optional(),
        block: z.string().max(120).optional(),
        role: z.string().max(60).optional(),
      }),
      req.query,
    );
    res.json(await admin.getOverviewTrend(actorOf(req), periods, filter));
  }),
);

mentorAdminRouter.get(
  '/benchmarks',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    const { period_id } = parseQuery(z.object({ period_id: uuid.optional() }), req.query);
    res.json(await admin.listBenchmarks(actorOf(req), period_id));
  }),
);

mentorAdminRouter.get(
  '/recognition',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    const { period_id } = parseQuery(z.object({ period_id: uuid.optional() }), req.query);
    res.json(await admin.getRecognition(actorOf(req), period_id));
  }),
);

mentorAdminRouter.get(
  '/config/versions',
  requirePermission('mentor_score:configure'),
  asyncHandler(async (req, res) => {
    res.json(await admin.listConfigVersions(actorOf(req)));
  }),
);

const flagSchema = z
  .object({
    visitId: uuid,
    ruleCode: z.string().trim().min(1).max(80),
    kind: z.enum(['inflation', 'contradiction']),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    explanation: z.string().trim().min(1).max(500),
    evidence: z.record(z.unknown()).optional(),
  })
  .strict();

// The rule engine (and reviewers raising a flag by hand) create flags here.
mentorAdminRouter.post(
  '/flags',
  requirePermission('mentor_flag:review'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createFlag(actorOf(req), parseBody(flagSchema, req.body)));
  }),
);

mentorAdminRouter.post(
  '/flags/:id/decision',
  requirePermission('mentor_flag:review'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          decision: z.enum(['start_review', 'confirm', 'dismiss', 'escalate', 'note']),
          reasonCode: z.string().trim().min(1).max(60).optional(),
          note: z.string().trim().max(1000).optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await service.decideFlag(actorOf(req), uuid.parse(req.params.id), body));
  }),
);

// ---- configuration ---------------------------------------------------------

const configShape = z
  .object({
    periodDays: z.number().int(),
    componentWeights: z.object({ compliance: z.number(), reliability: z.number() }),
    complianceWeights: z.object({ visit_coverage: z.number(), duration_validity: z.number(), spot_completion: z.number() }),
    reliabilityWeights: z.object({ inflation_reliability: z.number(), contradiction_reliability: z.number() }),
    minValidDurationMinutes: z.number(),
    durationCapMinutes: z.number(),
    minEvidence: z.object({ eligibleVisits: z.number(), qualityChecks: z.number() }),
    recognitionQualityFloor: z.number(),
    benchmarkMinCohort: z.number(),
    lateConfirmationPolicy: z.enum(['carryover', 'recalculate']),
    roleTargets: z.record(z.number()),
    defaultRoleTarget: z.number(),
    requireVerifiedLocation: z.boolean(),
    duplicateWindowMinutes: z.number(),
  })
  .strict();

mentorAdminRouter.get(
  '/config',
  requirePermission('mentor_score:configure'),
  asyncHandler(async (req, res) => {
    res.json({ active: await service.getActiveConfig(actorOf(req)), defaults: DEFAULT_SCORE_CONFIG });
  }),
);

// The PRD lists preview as a GET; a candidate configuration is a document, so
// it travels in a POST body.
mentorAdminRouter.post(
  '/config/preview',
  requirePermission('mentor_score:configure'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ periodId: uuid, config: configShape }).strict(), req.body);
    res.json(await service.previewConfig(actorOf(req), body.periodId, body.config as MentorScoreConfig));
  }),
);

mentorAdminRouter.post(
  '/config/publish',
  requirePermission('mentor_score:configure'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ config: configShape, effectiveFrom: date, note: z.string().max(500).optional() }).strict(),
      req.body,
    );
    res.status(201).json(await service.publishConfig(actorOf(req), { ...body, config: body.config as MentorScoreConfig }));
  }),
);

// ---- periods, setup, recalculation -------------------------------------------

mentorAdminRouter.get(
  '/periods',
  requirePermission('mentor_score:read_team'),
  asyncHandler(async (req, res) => {
    res.json(await service.listPeriods(actorOf(req)));
  }),
);

mentorAdminRouter.post(
  '/periods',
  requirePermission('mentor_score:configure'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ startDate: date }).strict(), req.body);
    res.status(201).json(await service.createPeriod(actorOf(req), body.startDate));
  }),
);

mentorAdminRouter.post(
  '/periods/:id/close',
  requirePermission('mentor_score:close_period'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.json(await closePeriod(actorOf(req), uuid.parse(req.params.id)));
  }),
);

mentorAdminRouter.post(
  '/periods/:id/publish',
  requirePermission('mentor_score:close_period'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    res.json(await service.publishPeriod(actorOf(req), uuid.parse(req.params.id)));
  }),
);

mentorAdminRouter.post(
  '/recalculate',
  requirePermission('mentor_score:recalculate'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ periodId: uuid, mentorId: uuid, reason: z.string().trim().min(5).max(500) }).strict(),
      req.body,
    );
    res.json(await recalculateMentor(actorOf(req), body.periodId, body.mentorId, body.reason));
  }),
);

mentorAdminRouter.put(
  '/mentors/:userId/profile',
  requirePermission('mentor_score:configure'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          mentorRole: z.string().trim().min(1).max(60),
          district: z.string().trim().max(120).nullable().optional(),
          block: z.string().trim().max(120).nullable().optional(),
          activeFrom: date.nullable().optional(),
          activeTo: date.nullable().optional(),
        })
        .strict()
        .refine((value) => !value.activeFrom || !value.activeTo || value.activeFrom <= value.activeTo, 'activeFrom must not be after activeTo'),
      req.body,
    );
    res.json(await service.upsertMentorProfile(actorOf(req), uuid.parse(req.params.userId), body));
  }),
);

mentorAdminRouter.post(
  '/exclusions',
  requirePermission('mentor_score:configure'),
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          userId: uuid.nullable().optional(),
          kind: z.enum(['training', 'outage', 'school_closed', 'other']),
          startDate: date,
          endDate: date,
          reason: z.string().trim().min(3).max(500),
        })
        .strict()
        .refine((value) => value.startDate <= value.endDate, 'startDate must not be after endDate'),
      req.body,
    );
    res.status(201).json(await service.createExclusion(actorOf(req), body));
  }),
);
