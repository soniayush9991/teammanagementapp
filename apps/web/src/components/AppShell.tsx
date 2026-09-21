import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { Avatar, Button } from './ui';
import { GlobalSearch } from './GlobalSearch';
import { NotificationBell } from './NotificationBell';

interface TeamSummary {
  id: string;
  name: string;
}

/**
 * The persistent frame: navigation, search and the notification bell. Routes
 * render into <main>, which carries the skip-link target.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { user, signOut, can } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<{ items: TeamSummary[] }>('/teams').then((response) => response.items),
    staleTime: 60_000,
  });

  const firstTeamId = teams?.[0]?.id;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className={`sidebar${sidebarOpen ? ' sidebar--open' : ''}`} aria-label="Primary">
        <div className="sidebar__brand">
          <span className="sidebar__mark" aria-hidden="true">
            TS
          </span>
          TeamSpace
        </div>

        <nav className="sidebar__nav" onClick={() => setSidebarOpen(false)}>
          <NavItem to="/" end icon="◧">
            My work
          </NavItem>
          {can('capacity:read_team') && (
            <NavItem to="/team" icon="◫">
              Team dashboard
            </NavItem>
          )}

          <p className="sidebar__section">Work</p>
          <NavItem to={firstTeamId ? `/board?teamId=${firstTeamId}` : '/board'} icon="▦">
            Kanban board
          </NavItem>
          <NavItem to="/tasks" icon="☰">
            All tasks
          </NavItem>
          <NavItem to="/calendar" icon="▤">
            Calendar
          </NavItem>
          {can('capacity:read_team') && (
            <NavItem to={firstTeamId ? `/planner?teamId=${firstTeamId}` : '/planner'} icon="◨">
              Capacity planner
            </NavItem>
          )}

          <p className="sidebar__section">Collaborate</p>
          <NavItem to="/chat" icon="◎">
            Messages
          </NavItem>
          <NavItem to="/groups" icon="◍">
            Groups
          </NavItem>

          {can('report:read_team') && (
            <>
              <p className="sidebar__section">Insight</p>
              <NavItem to={firstTeamId ? `/reports?teamId=${firstTeamId}` : '/reports'} icon="◔">
                Reports
              </NavItem>
            </>
          )}

          {can('audit:read') && (
            <>
              <p className="sidebar__section">Administration</p>
              <NavItem to="/admin" icon="⚙">
                Admin
              </NavItem>
            </>
          )}
        </nav>
      </aside>

      <header className="topbar">
        <Button
          variant="ghost"
          size="sm"
          className="sidebar-toggle"
          aria-label="Toggle navigation"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </Button>

        <GlobalSearch />
        <div className="spacer" />
        <NotificationBell />

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Avatar name={user?.displayName ?? 'You'} src={user?.avatarUrl} />
          <div className="truncate" style={{ maxWidth: 160 }}>
            <div className="truncate" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
              {user?.displayName}
            </div>
            <div className="tiny" style={{ textTransform: 'capitalize' }}>
              {user?.role}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void signOut().then(() => navigate('/login'));
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="main" id="main-content">
        {children}
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  end,
  children,
}: {
  to: string;
  icon: string;
  end?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </NavLink>
  );
}
