import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppLayout } from '@/components/layout/AppLayout';
import { AuthProvider, useAuth } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { BoardPage } from '@/pages/BoardPage';
import { CalibrationPage } from '@/pages/CalibrationPage';
import { CostsPage } from '@/pages/CostsPage';
import { ExecutionDetailPage } from '@/pages/ExecutionDetailPage';
import { ExecutionsPage } from '@/pages/ExecutionsPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotificationsPage } from '@/pages/NotificationsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <ProtectedRoute>
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<ExecutionsPage />} />
                <Route path="execution/:id" element={<ExecutionDetailPage />} />
                <Route path="board" element={<BoardPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="costs" element={<CostsPage />} />
                <Route path="calibration" element={<CalibrationPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <Toaster position="bottom-right" richColors />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
