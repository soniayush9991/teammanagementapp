import { Route, Routes } from 'react-router-dom';
import { EmptyState } from '../../components/ui';
import { ComplianceDetailPage } from './ComplianceDetailPage';
import { FeedbackPage } from './FeedbackPage';
import { FlagsPage } from './FlagsPage';
import { HistoryPage } from './HistoryPage';
import { ReliabilityDetailPage } from './ReliabilityDetailPage';
import { ReportCardPage } from './ReportCardPage';

/** Routes for /mentor/*. `history` is matched before the `:periodId` segment. */
export function MentorRoutes(): JSX.Element {
  return (
    <Routes>
      <Route index element={<ReportCardPage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path=":periodId" element={<ReportCardPage />} />
      <Route path=":periodId/compliance" element={<ComplianceDetailPage />} />
      <Route path=":periodId/reliability" element={<ReliabilityDetailPage />} />
      <Route path=":periodId/records" element={<FlagsPage />} />
      <Route path=":periodId/feedback" element={<FeedbackPage />} />
      <Route path="*" element={<EmptyState icon="?" title="Page not found" description="That link does not lead anywhere." />} />
    </Routes>
  );
}
