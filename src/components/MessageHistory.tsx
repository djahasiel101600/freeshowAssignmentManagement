import { useMemo, useState } from 'react';
import { useMessageLogs } from '../hooks/useMessageLogs';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import { Trash2, CheckCircle2, XCircle, Clock, History as HistoryIcon, Radar } from 'lucide-react';
import { cn } from '../lib/utils';

type StatusFilter = 'all' | 'sent' | 'failed' | 'pending';

const STATUS_META: Record<string, { icon: typeof CheckCircle2; text: string; badge: string }> = {
  sent: { icon: CheckCircle2, text: 'text-green-500', badge: 'bg-green-500/10 text-green-600' },
  failed: { icon: XCircle, text: 'text-red-500', badge: 'bg-red-500/10 text-red-600' },
  pending: { icon: Clock, text: 'text-yellow-500', badge: 'bg-yellow-500/10 text-yellow-600' },
};

export function MessageHistory() {
  const { logs, clearLogs } = useMessageLogs();
  const { info } = useToast();
  const [filter, setFilter] = useState<StatusFilter>('all');

  const stats = useMemo(
    () => ({
      total: logs.length,
      sent: logs.filter((l) => l.status === 'sent').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      pending: logs.filter((l) => l.status === 'pending').length,
    }),
    [logs]
  );

  const filteredLogs = useMemo(
    () => (filter === 'all' ? logs : logs.filter((l) => l.status === filter)),
    [logs, filter]
  );

  const filters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: `All (${stats.total})` },
    { id: 'sent', label: `Sent (${stats.sent})` },
    { id: 'failed', label: `Failed (${stats.failed})` },
    { id: 'pending', label: `Pending (${stats.pending})` },
  ];

  const handleClear = () => {
    if (confirm('Clear all message history? This cannot be undone.')) {
      clearLogs();
      info('Message history cleared', { title: 'History cleared' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Message History</h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <HistoryIcon className="h-3.5 w-3.5" />
            {stats.total} message{stats.total === 1 ? '' : 's'}
          </span>
        </div>
        {logs.length > 0 && (
          <Button variant="destructive" size="sm" onClick={handleClear}>
            <Trash2 className="h-4 w-4 mr-2" />
            Clear History
          </Button>
        )}
      </div>

      {logs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                filter === f.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filteredLogs.map((log) => {
          const meta = STATUS_META[log.status] ?? { icon: Radar, text: '', badge: 'bg-muted text-muted-foreground' };
          const Icon = meta.icon;
          return (
            <Card key={log.id}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{log.contactName}</h3>
                      <span className="truncate text-sm text-muted-foreground">{log.phoneNumber}</span>
                    </div>
                    <p className="my-2 text-sm text-muted-foreground line-clamp-3">{log.message}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{new Date(log.sentAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <span className={cn('flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize', meta.badge)}>
                    <Icon className={cn('h-4 w-4', meta.text)} />
                    {log.status}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {logs.length > 0 && filteredLogs.length === 0 && (
          <p className="py-8 text-center text-muted-foreground">
            No messages with this status yet.
          </p>
        )}

        {logs.length === 0 && (
          <div className="rounded-xl border border-dashed py-12 text-center">
            <Radar className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
            <h3 className="mb-1 font-semibold">No messages sent yet</h3>
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              When you send messages from the Messages tab, the results will appear here with
              their delivery status.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}