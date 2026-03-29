import { Outlet } from 'react-router-dom';
import { useSSE } from '@/lib/sse';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  const { connected } = useSSE();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header sseConnected={connected} />
        <main className="flex-1 overflow-y-auto bg-muted/40 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
