import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VariablesManager } from './components/VariablesManager';
import { ContactManager } from './components/ContactsManager';
import { MessageComposer } from './components/MessageComposer';
import { ConditionalSender } from './components/ConditionalSender';
import { MessageHistory } from './components/MessageHistory';
import { Settings } from './components/Settings';
import { AssignmentsPanel } from './components/AssignmentsPanel';
import { RotationPanel } from './components/RotationPanel';
import { UsersPanel } from './components/UsersPanel';
import { LoginPage } from './components/LoginPage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/ui/toast';
import { useTheme } from './hooks/useTheme';
import { fetchSettings } from './lib/store-api';
import { semaphoreAPI } from './lib/semaphore-api';
import { webhookAPI, type WebhookConfig } from './lib/webhook-api';
import {
  MessageSquare,
  Users,
  Settings as SettingsIcon,
  History,
  Variable,
  Sun,
  Moon,
  Monitor,
  Workflow,
  CalendarClock,
  LogOut,
  Repeat,
} from 'lucide-react';

const queryClient = new QueryClient();

type Tab =
  | 'variables'
  | 'assignments'
  | 'rotation'
  | 'contacts'
  | 'compose'
  | 'conditional'
  | 'history'
  | 'account'
  | 'settings';

function ThemeToggle() {
  const { theme, setTheme, preference } = useTheme();
  return (
    <div className="flex items-center gap-1 rounded-full bg-muted p-1" role="group" aria-label="Theme">
      <button
        onClick={() => setTheme('light')}
        aria-label="Light theme"
        aria-pressed={preference === 'light'}
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
          (preference === 'light' || (preference === 'system' && theme === 'light'))
            ? 'bg-background text-foreground shadow'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Sun className="h-4 w-4" />
      </button>
      <button
        onClick={() => setTheme('dark')}
        aria-label="Dark theme"
        aria-pressed={preference === 'dark'}
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
          (preference === 'dark' || (preference === 'system' && theme === 'dark'))
            ? 'bg-background text-foreground shadow'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Moon className="h-4 w-4" />
      </button>
      <button
        onClick={() => setTheme('system')}
        aria-label="System theme"
        aria-pressed={preference === 'system'}
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
          preference === 'system'
            ? 'bg-background text-foreground shadow'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Monitor className="h-4 w-4" />
      </button>
    </div>
  );
}

function AppContent() {
  const { user, isAdmin, loading, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    return (localStorage.getItem('activeTab') as Tab) || 'variables';
  });

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  // Push the saved integration settings (Semaphore key, n8n webhook) into
  // their API clients once after sign-in, so every tab can use them without
  // the Settings tab having to be visited first.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void fetchSettings()
      .then((loaded) => {
        if (cancelled || !loaded) return;
        const semaphore = loaded.semaphore as { apiKey?: string; senderName?: string } | undefined;
        if (semaphore && semaphore.apiKey) {
          semaphoreAPI.setConfig({ apiKey: semaphore.apiKey, senderName: semaphore.senderName ?? 'ChurchName' });
        }
        const webhook = loaded.webhook as Partial<WebhookConfig> | undefined;
        if (webhook && webhook.url) {
          webhookAPI.setConfig({ ...webhook } as WebhookConfig);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        Checking your session…
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const tabs = [
    { id: 'variables' as Tab, label: 'Variables', icon: Variable },
    { id: 'assignments' as Tab, label: 'Schedule', icon: CalendarClock },
    { id: 'rotation' as Tab, label: 'Rotation', icon: Repeat },
    { id: 'contacts' as Tab, label: 'Contacts', icon: Users },
    { id: 'compose' as Tab, label: 'Messages', icon: MessageSquare },
    { id: 'conditional' as Tab, label: 'Conditional', icon: Workflow },
    { id: 'history' as Tab, label: 'History', icon: History },
    { id: 'account' as Tab, label: 'Account', icon: Users },
    { id: 'settings' as Tab, label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="FreeShow SMS Manager logo" className="h-8 w-8" />
            <div>
              <h1 className="text-lg font-bold leading-tight">FreeShow SMS Manager</h1>
              <p className="text-xs text-muted-foreground leading-tight">
                Personnel assignments & notifications
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user && (
              <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
                <span className="hidden text-xs font-medium sm:inline">
                  {user.displayName}
                  {isAdmin && <span className="ml-1 text-muted-foreground">(admin)</span>}
                </span>
                <button
                  onClick={() => void logout()}
                  aria-label="Sign out"
                  title={`Sign out ${user.username}`}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="sticky top-16 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container mx-auto max-w-6xl px-2 sm:px-4">
          <div className="flex gap-1 overflow-x-auto py-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                aria-current={activeTab === id ? 'page' : undefined}
                className={`group flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  activeTab === id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="container mx-auto max-w-6xl flex-1 px-4 py-8">
        {activeTab === 'variables' && <VariablesManager />}
        {activeTab === 'assignments' && <AssignmentsPanel />}
        {activeTab === 'rotation' && <RotationPanel />}
        {activeTab === 'contacts' && <ContactManager />}
        {activeTab === 'compose' && <MessageComposer />}
        {activeTab === 'conditional' && <ConditionalSender />}
        {activeTab === 'history' && <MessageHistory />}
        {activeTab === 'account' && <UsersPanel />}
        {activeTab === 'settings' && <Settings />}
      </main>

      <footer className="border-t py-4">
        <div className="container mx-auto max-w-6xl px-4 text-center text-xs text-muted-foreground">
          FreeShow SMS Manager • Presentation variables, contacts & personnel notifications
        </div>
      </footer>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;