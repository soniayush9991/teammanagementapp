import { Route, Routes } from 'react-router-dom';
import { EmptyState } from '../../components/ui';
import { MentorAdminLayout } from '../../components/mentorAdmin/parts';
import { useAuth } from '../../state/AuthContext';
import { BenchmarksPage } from './BenchmarksPage';
import { ConfigPage } from './ConfigPage';
import { FlagQueuePage } from './FlagQueuePage';
import { MentorDrilldownPage } from './MentorDrilldownPage';
import { MentorsPage } from './MentorsPage';
import { OverviewPage } from './OverviewPage';
import { RecognitionPage } from './RecognitionPage';

/** Routes for /mentor-admin/*. Configuration is admin-only; the API enforces it too. */
export function MentorAdminRoutes(): JSX.Element {
  const { can } = useAuth();
  return (
    <Routes>
      <Route element={<MentorAdminLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="mentors" element={<MentorsPage />} />
        <Route path="mentors/:mentorId" element={<MentorDrilldownPage />} />
        <Route path="flags" element={<FlagQueuePage />} />
        <Route path="recognition" element={<RecognitionPage />} />
        <Route path="benchmarks" element={<BenchmarksPage />} />
        <Route
          path="config"
          element={can('mentor_score:configure') ? <ConfigPage /> : <EmptyState icon="🔒" title="Admins only" description="Scoring configuration can only be changed by an administrator." />}
        />
        <Route path="*" element={<EmptyState icon="?" title="Page not found" description="That link does not lead anywhere." />} />
      </Route>
    </Routes>
  );
}
