import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { serverApi } from '../lib/server-api';
import type { FreeShowVariable } from '../types/freeshow';

const QUERY_KEY = ['freeshow-variables'];

export function useFreeShowVariables() {
  const queryClient = useQueryClient();

  const variablesQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => serverApi.getServerVariables(),
    refetchInterval: 10000, // Auto-refresh every 10 seconds
    retry: 1, // Only retry once if failed
  });

  // Optimistically apply edits to the cached snapshot so the UI feels
  // instant; the real value arrives via the bridge's next snapshot sync.
  const applyOptimistic = (updates: Array<{ id: string; value: string }>) => {
    queryClient.setQueryData<FreeShowVariable[]>(QUERY_KEY, (old) =>
      old
        ? old.map((variable) => {
            const update = updates.find((u) => u.id === variable.id);
            return update ? { ...variable, value: update.value } : variable;
          })
        : old
    );
  };

  const updateVariableMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      serverApi.postVariableCommand(id, value),
    onMutate: ({ id, value }) => applyOptimistic([{ id, value }]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const updateVariablesMutation = useMutation({
    mutationFn: (updates: Array<{ id: string; value: string }>) =>
      serverApi.postVariableCommands(updates),
    onMutate: (updates) => applyOptimistic(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return {
    variables: variablesQuery.data || [],
    isLoading: variablesQuery.isLoading,
    error: variablesQuery.error,
    refetch: variablesQuery.refetch,
    lastSyncedAt: variablesQuery.dataUpdatedAt || 0,
    updateVariable: updateVariableMutation.mutate,
    updateVariableAsync: updateVariableMutation.mutateAsync,
    updateVariables: updateVariablesMutation.mutate,
    updateVariablesAsync: updateVariablesMutation.mutateAsync,
    isUpdating: updateVariableMutation.isPending || updateVariablesMutation.isPending,
  };
}