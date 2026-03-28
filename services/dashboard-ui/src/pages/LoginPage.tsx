import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';

export function LoginPage() {
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!tokenInput.trim()) {
      setError('Token is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/dashboard/executions?limit=1', {
        headers: { Authorization: `Bearer ${tokenInput.trim()}` },
      });

      if (!response.ok) {
        setError('Invalid token. Please check and try again.');
        return;
      }

      login(tokenInput.trim());
      navigate('/', { replace: true });
    } catch {
      setError('Connection failed. Is the API running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <span className="text-xl font-bold text-primary-foreground">P</span>
          </div>
          <h1 className="text-xl font-bold">Pullmint Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your dashboard token to connect
          </p>
        </div>

        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4"
        >
          <Input
            type="password"
            placeholder="Dashboard token"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            autoFocus
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Connecting...' : 'Connect'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
