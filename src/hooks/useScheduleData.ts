import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as store from '../lib/store-api';
import type { ScheduleRuleInput } from '../types/assignments';

/**
 * Assignment ledger + rotation analysis hooks.
 *
 * The ledger is written by the bridge automatically; the mutations here exist
 * so an operator can correct a day by hand (``createAssignment``) or remove a
 * mistake (``removeAssignment``). Everything else is read-only analysis.
 */

// --------------------------------------------------------------------------- //
// Ledger
// --------------------------------------------------------------------------- //
export function useAssignments(params: {
  from?: string;
  to?: string;
  variable?: string;
  person?: string;
  limit?: number;
} = {}) {
  const queryClient = useQueryClient();
  const key = ['assignments', params];

  const query = useQuery({
    queryKey: key,
    queryFn: () => store.fetchAssignments(params),
    staleTime: 15_000,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['assignments'] });
    queryClient.invalidateQueries({ queryKey: ['assignment-changes'] });
    queryClient.invalidateQueries({ queryKey: ['rotation'] });
  };

  const create = useMutation({ mutationFn: store.createAssignment, onSuccess: invalidateAll });
  const remove = useMutation({ mutationFn: store.deleteAssignment, onSuccess: invalidateAll });

  return {
    assignments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    recordAssignment: create.mutateAsync,
    removeAssignment: remove.mutateAsync,
  };
}

export function useAssignmentChanges(params: {
  variable?: string;
  person?: string;
  from?: string;
  to?: string;
  limit?: number;
} = {}) {
  const query = useQuery({
    queryKey: ['assignment-changes', params],
    queryFn: () => store.fetchAssignmentChanges(params),
    staleTime: 15_000,
  });
  return {
    changes: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

// --------------------------------------------------------------------------- //
// Rotation
// --------------------------------------------------------------------------- //
export function useRotationVariables() {
  const query = useQuery({
    queryKey: ['rotation', 'variables'],
    queryFn: store.fetchRotationVariables,
    staleTime: 30_000,
  });
  return { variables: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch };
}

/** Overview of every tracked variable, or the full report for one. */
export function useRotation(variable?: string, lookbackDays = 730) {
  const query = useQuery({
    queryKey: ['rotation', 'summary', variable ?? 'all', lookbackDays],
    queryFn: () => store.fetchRotationSummary(variable, lookbackDays),
    staleTime: 30_000,
  });
  return {
    report: query.data?.report ?? null,
    overview: query.data?.reports ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useRotationPeople(variable?: string) {
  const query = useQuery({
    queryKey: ['rotation', 'people', variable ?? 'all'],
    queryFn: () => store.fetchRotationPeople(variable),
    staleTime: 30_000,
  });
  return {
    people: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

// --------------------------------------------------------------------------- //
// Recurring schedules
// --------------------------------------------------------------------------- //
/**
 * The calendar behind the rotation analysis.
 *
 * A variable's assignments repeat on a regular weekday ("every Sunday") that the
 * operator declares here; the server then knows which service each recorded
 * entry is *for*, so the prediction lands on a Friday/Saturday/Sunday instead of
 * on the evening the schedule was typed in.
 */
export function useSchedules() {
  const query = useQuery({
    queryKey: ['schedules'],
    queryFn: store.fetchSchedules,
    staleTime: 30_000,
  });
  return {
    schedules: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useSaveSchedule() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ variableName, rule }: { variableName: string; rule: ScheduleRuleInput }) =>
      store.putSchedule(variableName, rule),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['rotation'] });
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
    },
  });
  return { saveSchedule: mutation.mutateAsync, isSaving: mutation.isPending };
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: store.deleteSchedule,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['rotation'] });
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
    },
  });
  return { deleteSchedule: mutation.mutateAsync, isDeleting: mutation.isPending };
}

export function useBackfillSchedules() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: store.backfillSchedules,
    onSuccess: (result) => {
      // A dry run changes nothing, so leave the caches alone.
      if (result.dryRun) return;
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['rotation'] });
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
    },
  });
  return { backfillSchedules: mutation.mutateAsync, isApplying: mutation.isPending };
}

// --------------------------------------------------------------------------- //
// Tracking configuration
// --------------------------------------------------------------------------- //
export function useTracking() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['tracking'],
    queryFn: store.fetchTracking,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: store.putTracking,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracking'] });
      queryClient.invalidateQueries({ queryKey: ['rotation'] });
    },
  });

  return {
    tracking: query.data ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
    saveTracking: save.mutateAsync,
  };
}