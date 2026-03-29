import { Menu } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Sidebar } from './Sidebar';

interface HeaderProps {
  sseConnected: boolean;
}

const routeLabels: Record<string, string> = {
  '/': 'Executions',
  '/board': 'Risk Board',
  '/analytics': 'Analytics',
  '/costs': 'Costs',
  '/calibration': 'Calibration',
  '/notifications': 'Notifications',
};

export function Header({ sseConnected }: HeaderProps) {
  const location = useLocation();
  const currentLabel =
    routeLabels[location.pathname] ||
    (location.pathname.startsWith('/execution/') ? 'Execution Detail' : 'Dashboard');

  return (
    <header className="flex h-16 items-center gap-4 border-b bg-card px-6">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <Sidebar />
        </SheetContent>
      </Sheet>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Dashboard</span>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">{currentLabel}</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div
          className={cn(
            'h-2 w-2 rounded-full',
            sseConnected ? 'animate-pulse-dot bg-emerald-500' : 'bg-gray-400'
          )}
        />
        <span className="hidden sm:inline">{sseConnected ? 'Live' : 'Disconnected'}</span>
      </div>
    </header>
  );
}
