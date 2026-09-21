import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Team } from '@teamspace/shared';
import { api } from '../api/client';
import { Select } from './ui';

/**
 * The selected team lives in the URL, so a link to a board or report always
 * opens on the team the sender was looking at.
 */
export function useTeamSelection(): {
  teamId: string | undefined;
  setTeamId: (teamId: string) => void;
  teams: Team[];
} {
  const [params, setParams] = useSearchParams();
  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<{ items: Team[] }>('/teams').then((response) => response.items),
    staleTime: 60_000,
  });

  const fromUrl = params.get('teamId') ?? undefined;
  const resolved = fromUrl ?? teams?.[0]?.id;

  // Reflect the implicit default into the URL so the page is shareable.
  useEffect(() => {
    if (!fromUrl && resolved) {
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set('teamId', resolved);
        return next;
      }, { replace: true });
    }
  }, [fromUrl, resolved, setParams]);

  return {
    teamId: resolved,
    teams: teams ?? [],
    setTeamId: (teamId) =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set('teamId', teamId);
        return next;
      }),
  };
}

export function TeamPicker({
  teams,
  teamId,
  onChange,
}: {
  teams: Team[];
  teamId: string | undefined;
  onChange: (teamId: string) => void;
}): JSX.Element {
  return (
    <>
      <label className="sr-only" htmlFor="team-picker">
        Team
      </label>
      <Select
        id="team-picker"
        value={teamId ?? ''}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: 'auto', minWidth: 180 }}
      >
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </Select>
    </>
  );
}
