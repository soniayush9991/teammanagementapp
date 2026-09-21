import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Button, Card, Field, Input } from '../components/ui';
import { useAuth } from '../state/AuthContext';

export function LoginPage(): JSX.Element {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (caught) {
      // The API deliberately does not say which of the two was wrong.
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in, please try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__card">
        <Card>
          <div className="row" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="sidebar__mark" aria-hidden="true">
              TS
            </span>
            <div>
              <h1 style={{ fontSize: 'var(--text-xl)' }}>Sign in to TeamSpace</h1>
              <p className="tiny">Track work, capacity and conversations in one place.</p>
            </div>
          </div>

          <form onSubmit={(event) => void onSubmit(event)} noValidate>
            <Field label="Work email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
            </Field>

            <Field label="Password" htmlFor="password" error={error ?? undefined}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'password-error' : undefined}
              />
            </Field>

            <Button type="submit" block disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="auth__demo">
            <strong>Demo accounts</strong> — password <code>TeamSpace!2026</code>
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-5)' }}>
              <li>maya@teamspace.dev — manager</li>
              <li>sam@teamspace.dev — team member</li>
              <li>admin@teamspace.dev — administrator</li>
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}
