import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SearchHit } from '@teamspace/shared';
import { api, qs } from '../api/client';
import { useDebounced } from '../hooks/useDebounced';

/**
 * Search across tasks, messages and files. Results are keyboard navigable and
 * the input is reachable with "/" from anywhere in the app.
 */
export function GlobalSearch(): JSX.Element {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(term, 250);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ items: SearchHit[] }>(`/search${qs({ q: debounced, limit: 8 })}`).then((r) => r.items),
    enabled: debounced.trim().length >= 2,
    staleTime: 15_000,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typingElsewhere =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === '/' && !typingElsewhere) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  const results = data ?? [];

  return (
    <div className="topbar__search" ref={containerRef}>
      <input
        ref={inputRef}
        className="input"
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="global-search-results"
        aria-label="Search tasks, messages and files"
        placeholder="Search tasks, messages and files…  /"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />

      {open && debounced.trim().length >= 2 && (
        <div className="search-results" id="global-search-results" role="listbox">
          {isFetching && results.length === 0 && <p className="search-result muted">Searching…</p>}
          {!isFetching && results.length === 0 && (
            <p className="search-result muted">No matches for “{debounced}”.</p>
          )}
          {results.map((hit) => (
            <Link
              key={`${hit.type}-${hit.id}`}
              to={hit.link}
              className="search-result"
              role="option"
              aria-selected="false"
              onClick={() => setOpen(false)}
            >
              <div className="row row--between">
                <strong className="truncate">{hit.title}</strong>
                <span className="badge">{hit.type}</span>
              </div>
              {/* The API returns <mark> around matched terms; it is the only
                  markup allowed here and it comes from ts_headline, not user
                  input rendered verbatim. */}
              <p
                className="tiny"
                // eslint-disable-next-line react/no-danger -- server-generated highlight markup
                dangerouslySetInnerHTML={{ __html: sanitizeHighlight(hit.snippet) }}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ts_headline returns the surrounding text verbatim with <mark> inserted, so
 * the body is escaped here and only the highlight tags are re-introduced.
 */
function sanitizeHighlight(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}
