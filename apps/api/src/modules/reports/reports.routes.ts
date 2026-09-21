import { Router } from 'express';
import { z } from 'zod';
import { isoWeekKey } from '@teamspace/shared';
import { toCsv, type CsvColumn } from '../../lib/csv.js';
import { asyncHandler, parseQuery, uuid } from '../../lib/http.js';
import { renderTablePdf } from '../../lib/pdf.js';
import { actorOf, authenticate, requirePermission } from '../../middleware/auth.js';
import { assignmentHistory } from '../assignments/assignments.service.js';
import * as service from './reports.service.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate, requirePermission('report:read_team'));

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const weekKey = z
  .string()
  .regex(/^\d{4}-W\d{2}$/)
  .default(() => isoWeekKey(new Date()));

function defaultFrom(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const today = (): string => new Date().toISOString().slice(0, 10);

reportsRouter.get(
  '/workload',
  asyncHandler(async (req, res) => {
    const { teamId, week } = parseQuery(z.object({ teamId: uuid, week: weekKey }), req.query);
    res.json(await service.employeeWorkloadReport(actorOf(req), teamId, week));
  }),
);

reportsRouter.get(
  '/utilization',
  asyncHandler(async (req, res) => {
    const { teamId, weeks } = parseQuery(
      z.object({ teamId: uuid, weeks: z.coerce.number().int().min(1).max(26).default(8) }),
      req.query,
    );
    res.json(await service.utilizationReport(actorOf(req), teamId, weeks));
  }),
);

reportsRouter.get(
  '/completion-trend',
  asyncHandler(async (req, res) => {
    const { teamId, from, to } = parseQuery(
      z.object({ teamId: uuid, from: dateString.default(() => defaultFrom(30)), to: dateString.default(today) }),
      req.query,
    );
    res.json(await service.completionTrendReport(actorOf(req), teamId, from, to));
  }),
);

reportsRouter.get(
  '/overdue',
  asyncHandler(async (req, res) => {
    const { teamId } = parseQuery(z.object({ teamId: uuid }), req.query);
    res.json(await service.overdueReport(actorOf(req), teamId));
  }),
);

reportsRouter.get(
  '/productivity',
  asyncHandler(async (req, res) => {
    const { teamId, from, to } = parseQuery(
      z.object({ teamId: uuid, from: dateString.default(() => defaultFrom(30)), to: dateString.default(today) }),
      req.query,
    );
    res.json(await service.productivityReport(actorOf(req), teamId, from, to));
  }),
);

/**
 * One export endpoint for every report, so adding a report does not mean
 * adding two more routes. `format` decides the serializer; the report name
 * decides the columns.
 */
const exportSchema = z.object({
  teamId: uuid,
  format: z.enum(['csv', 'pdf']).default('csv'),
  week: weekKey,
  weeks: z.coerce.number().int().min(1).max(26).default(8),
  from: dateString.default(() => defaultFrom(30)),
  to: dateString.default(today),
});

interface ExportPayload {
  title: string;
  columns: { header: string; width: number; value: (row: never) => unknown }[];
  rows: unknown[];
  subtitle: string;
}

reportsRouter.get(
  '/:reportName/export',
  requirePermission('report:export'),
  asyncHandler(async (req, res) => {
    const name = service.assertKnownReport(String(req.params.reportName));
    const options = parseQuery(exportSchema, req.query);
    const actor = actorOf(req);

    const payload = await buildExport(name, actor, options);
    const filename = `${name}-${options.teamId.slice(0, 8)}-${today()}`;

    if (options.format === 'pdf') {
      const pdf = renderTablePdf({
        title: payload.title,
        subtitle: payload.subtitle,
        columns: payload.columns.map((column) => ({ header: column.header, width: column.width })),
        rows: payload.rows.map((row) =>
          payload.columns.map((column) => {
            const value = (column.value as (input: unknown) => unknown)(row);
            return value === null || value === undefined ? '' : String(value);
          }),
        ),
      });
      res
        .status(200)
        .setHeader('content-type', 'application/pdf')
        .setHeader('content-disposition', `attachment; filename="${filename}.pdf"`)
        .send(pdf);
      return;
    }

    const csv = toCsv(
      payload.rows,
      payload.columns.map((column) => ({ header: column.header, value: column.value })) as CsvColumn<unknown>[],
    );
    res
      .status(200)
      .setHeader('content-type', 'text/csv; charset=utf-8')
      .setHeader('content-disposition', `attachment; filename="${filename}.csv"`)
      .send(csv);
  }),
);

async function buildExport(
  name: service.ReportName,
  actor: ReturnType<typeof actorOf>,
  options: z.infer<typeof exportSchema>,
): Promise<ExportPayload> {
  switch (name) {
    case 'workload': {
      const report = await service.employeeWorkloadReport(actor, options.teamId, options.week);
      return {
        title: 'Employee workload report',
        subtitle: `Week ${report.weekKey} · generated ${report.generatedAt}`,
        rows: report.rows,
        columns: [
          { header: 'Employee', width: 130, value: (row: service.WorkloadReportRow) => row.displayName },
          { header: 'Role', width: 110, value: (row: service.WorkloadReportRow) => row.jobTitle ?? '' },
          { header: 'Capacity (h)', width: 70, value: (row: service.WorkloadReportRow) => row.weeklyCapacityHours },
          { header: 'Leave (h)', width: 60, value: (row: service.WorkloadReportRow) => row.leaveHours },
          { header: 'Planned (h)', width: 70, value: (row: service.WorkloadReportRow) => row.plannedHours },
          { header: 'Available (h)', width: 75, value: (row: service.WorkloadReportRow) => row.availableHours },
          { header: 'Over (h)', width: 60, value: (row: service.WorkloadReportRow) => row.overAllocationHours },
          {
            header: 'Utilization',
            width: 70,
            value: (row: service.WorkloadReportRow) =>
              Number.isFinite(row.utilization) ? `${Math.round(row.utilization * 100)}%` : 'n/a',
          },
          { header: 'Status', width: 80, value: (row: service.WorkloadReportRow) => row.band },
          { header: 'Open', width: 45, value: (row: service.WorkloadReportRow) => row.openTaskCount },
          { header: 'Overdue', width: 55, value: (row: service.WorkloadReportRow) => row.overdueTaskCount },
        ] as ExportPayload['columns'],
      };
    }
    case 'utilization': {
      const report = await service.utilizationReport(actor, options.teamId, options.weeks);
      return {
        title: 'Capacity utilization report',
        subtitle: `${options.weeks} weeks from ${isoWeekKey(new Date())} · generated ${report.generatedAt}`,
        rows: report.rows,
        columns: [
          { header: 'Week', width: 90, value: (row: service.UtilizationTrendRow) => row.weekKey },
          { header: 'Capacity (h)', width: 90, value: (row: service.UtilizationTrendRow) => row.capacityHours },
          { header: 'Planned (h)', width: 90, value: (row: service.UtilizationTrendRow) => row.plannedHours },
          {
            header: 'Utilization',
            width: 90,
            value: (row: service.UtilizationTrendRow) => `${Math.round(row.utilization * 100)}%`,
          },
          { header: 'Overloaded people', width: 120, value: (row: service.UtilizationTrendRow) => row.overloadedCount },
        ] as ExportPayload['columns'],
      };
    }
    case 'completion-trend': {
      const report = await service.completionTrendReport(actor, options.teamId, options.from, options.to);
      return {
        title: 'Task completion trend',
        subtitle: `${options.from} to ${options.to} · generated ${report.generatedAt}`,
        rows: report.rows,
        columns: [
          { header: 'Day', width: 90, value: (row: service.CompletionTrendRow) => row.day },
          { header: 'Created', width: 70, value: (row: service.CompletionTrendRow) => row.createdCount },
          { header: 'Completed', width: 80, value: (row: service.CompletionTrendRow) => row.completedCount },
          { header: 'Logged (h)', width: 80, value: (row: service.CompletionTrendRow) => row.loggedHours },
        ] as ExportPayload['columns'],
      };
    }
    case 'overdue': {
      const report = await service.overdueReport(actor, options.teamId);
      return {
        title: 'Overdue task report',
        subtitle: `As of ${today()} · generated ${report.generatedAt}`,
        rows: report.rows,
        columns: [
          { header: 'Task', width: 70, value: (row: service.OverdueReportRow) => row.taskKey },
          { header: 'Title', width: 220, value: (row: service.OverdueReportRow) => row.title },
          { header: 'Status', width: 80, value: (row: service.OverdueReportRow) => row.status },
          { header: 'Priority', width: 60, value: (row: service.OverdueReportRow) => row.priority },
          { header: 'Due', width: 80, value: (row: service.OverdueReportRow) => row.dueDate ?? '' },
          { header: 'Days late', width: 65, value: (row: service.OverdueReportRow) => row.daysOverdue },
          { header: 'Assignees', width: 140, value: (row: service.OverdueReportRow) => row.assignees },
          { header: 'Remaining (h)', width: 80, value: (row: service.OverdueReportRow) => row.remainingHours },
        ] as ExportPayload['columns'],
      };
    }
    case 'productivity': {
      const report = await service.productivityReport(actor, options.teamId, options.from, options.to);
      return {
        title: 'Team productivity report',
        subtitle: `${options.from} to ${options.to} · generated ${report.generatedAt}`,
        rows: report.rows,
        columns: [
          { header: 'Employee', width: 150, value: (row: service.ProductivityRow) => row.displayName },
          { header: 'Completed', width: 80, value: (row: service.ProductivityRow) => row.completedTasks },
          { header: 'Logged (h)', width: 80, value: (row: service.ProductivityRow) => row.loggedHours },
          { header: 'Avg cycle (days)', width: 110, value: (row: service.ProductivityRow) => row.avgCycleTimeDays },
          { header: 'Overdue now', width: 90, value: (row: service.ProductivityRow) => row.overdueTasks },
        ] as ExportPayload['columns'],
      };
    }
    case 'assignment-history': {
      const rows = await assignmentHistory(actor, {
        teamId: options.teamId,
        from: options.from,
        to: options.to,
        limit: 500,
      });
      return {
        title: 'Assignment history',
        subtitle: `${options.from} to ${options.to} · generated ${new Date().toISOString()}`,
        rows,
        columns: [
          { header: 'When', width: 130, value: (row: { createdAt: string }) => row.createdAt },
          { header: 'Task', width: 70, value: (row: { taskKey: string }) => row.taskKey },
          { header: 'Title', width: 200, value: (row: { taskTitle: string }) => row.taskTitle },
          { header: 'Action', width: 80, value: (row: { action: string }) => row.action },
          { header: 'Assignee', width: 120, value: (row: { userName: string | null }) => row.userName ?? '' },
          { header: 'Previously', width: 110, value: (row: { fromUserName: string | null }) => row.fromUserName ?? '' },
          { header: 'By', width: 110, value: (row: { actorName: string | null }) => row.actorName ?? '' },
        ] as ExportPayload['columns'],
      };
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unhandled report ${String(exhaustive)}`);
    }
  }
}
