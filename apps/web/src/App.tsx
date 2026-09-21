import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '@teamspace/shared';
import { AppShell } from './components/AppShell';
import { Toasts } from './components/Toasts';
import { EmptyState, LoadingBlock } from './components/ui';
import { useRealtime } from './hooks/useRealtime';
import { useAuth } from './state/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { MyWorkPage } from './pages/MyWorkPage';
import { TeamDashboardPage } from './pages/TeamDashboardPage';
import { BoardPage } from './pages/BoardPage';
import { TaskListPage } from './pages/TaskListPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { CalendarPage } from './pages/CalendarPage';
import { PlannerPage } from './pages/PlannerPage';
import { ChatPage } from './pages/ChatPage';
import { GroupsPage } from './pages/GroupsPage';
import { ReportsPage } from './pages/ReportsPage';
import { AdminPage } from './pages/AdminPage';

export function App(): JSX.Element {
  const { status } = useAuth();
  // Mounted once, inside the authenticated tree, so a single socket serves
  // every screen.
  useRealtime();

  if (status === 'loading') {
    return (
      <div className="auth">
        <div className="auth__card">
          <LoadingBlock rows={3} label="Restoring your session" />
        </div>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={status === 'authenticated' ? <Navigate to="/" replace /> : <LoginPage />} />

        <Route
          path="/*"
          element={
            <RequireAuth>
              <AppShell>
                <Routes>
                  <Route path="/" element={<MyWorkPage />} />
                  <Route
                    path="/team"
                    element={
                      <RequirePermission permission="capacity:read_team">
                        <TeamDashboardPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/board" element={<BoardPage />} />
                  <Route path="/tasks" element={<TaskListPage />} />
                  <Route path="/tasks/:taskKey" element={<TaskDetailPage />} />
                  <Route path="/calendar" element={<CalendarPage />} />
                  <Route
                    path="/planner"
                    element={
                      <RequirePermission permission="capacity:read_team">
                        <PlannerPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/chat" element={<ChatPage />} />
                  <Route path="/chat/:conversationId" element={<ChatPage />} />
                  <Route path="/groups" element={<GroupsPage />} />
                  <Route
                    path="/reports"
                    element={
                      <RequirePermission permission="report:read_team">
                        <ReportsPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin"
                    element={
                      <RequirePermission permission="audit:read">
                        <AdminPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="*"
                    element={<EmptyState icon="?" title="Page not found" description="That link does not lead anywhere." />}
                  />
                </Routes>
              </AppShell>
            </RequireAuth>
          }
        />
      </Routes>
      <Toasts />
    </>
  );
}

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();
  if (status !== 'authenticated') {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

/**
 * Hiding a control is a usability nicety, not a security boundary — the API
 * enforces the same permission on every request.
 */
function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: JSX.Element;
}): JSX.Element {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <EmptyState
        icon="🔒"
        title="You do not have access to this page"
        description="Ask an administrator if you think you should."
      />
    );
  }
  return children;
}
