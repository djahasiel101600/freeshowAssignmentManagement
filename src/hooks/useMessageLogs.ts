import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as store from '../lib/store-api';
import type { MessageLog } from '../types/messages';

const QUERY_KEY = ['message-logs'];

/**
 * Message history is stored in the database (previously localStorage), so the
 * log survives restarts and is visible to every operator. The old API shape
 * (`logs`, `addLog`, `addLogs`, `clearLogs`) is preserved for MessageHistory.
 */
export function useMessageLogs() {
  const queryClient = useQueryClient();

  const logsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => store.fetchLogs(),
    staleTime: 15_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const addLogsMutation = useMutation({
    mutationFn: (newLogs: Array<Omit<MessageLog, 'id'>>) => store.appendLogs(newLogs),
    onSuccess: invalidate,
  });

  const clearLogsMutation = useMutation({
    mutationFn: () => store.clearLogs(),
    onSuccess: invalidate,
  });

  return {
    logs: logsQuery.data ?? [],
    isLoading: logsQuery.isLoading,
    error: logsQuery.error,
    refetch: logsQuery.refetch,
    addLog: (log: Omit<MessageLog, 'id'>) => addLogsMutation.mutate([log]),
    addLogs: (newLogs: Array<Omit<MessageLog, 'id'>>) => addLogsMutation.mutate(newLogs),
    /** Awaitable variant for callers that need to know the write succeeded. */
    addLogsAsync: (newLogs: Array<Omit<MessageLog, 'id'>>) => addLogsMutation.mutateAsync(newLogs),
    clearLogs: () => clearLogsMutation.mutate(),
  };
}
