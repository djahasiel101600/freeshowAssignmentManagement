import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as store from '../lib/store-api';
import type { ConditionalRule, SavedTemplate } from '../types/templates';
import type { AuthUser } from '../types/auth';

/**
 * Templates, conditional rules, settings and users.
 *
 * All four are now database-backed, so the hook surface is deliberately thin:
 * read with `useQuery`, write with a mutation that invalidates the key. The
 * composer/conditional sender keep their own working copy for editing, and only
 * announce completed writes here.
 */

// --------------------------------------------------------------------------- //
// Templates
// --------------------------------------------------------------------------- //
export function useTemplates() {
  const queryClient = useQueryClient();
  const key = ['templates'];

  const query = useQuery({ queryKey: key, queryFn: store.fetchTemplates, staleTime: 30_000 });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({ mutationFn: store.createTemplate, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<SavedTemplate> }) =>
      store.updateTemplate(id, payload),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: store.deleteTemplate, onSuccess: invalidate });

  return {
    templates: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create: create.mutateAsync,
    update: (id: string, payload: Partial<SavedTemplate>) => update.mutateAsync({ id, payload }),
    remove: remove.mutateAsync,
  };
}

// --------------------------------------------------------------------------- //
// Conditional rules
// --------------------------------------------------------------------------- //
export function useConditionalRules() {
  const queryClient = useQueryClient();
  const key = ['conditional-rules'];

  const query = useQuery({ queryKey: key, queryFn: store.fetchRules, staleTime: 30_000 });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({ mutationFn: store.createRule, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<ConditionalRule> }) =>
      store.updateRule(id, payload),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: store.deleteRule, onSuccess: invalidate });

  return {
    rules: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create: create.mutateAsync,
    update: (id: string, payload: Partial<ConditionalRule>) => update.mutateAsync({ id, payload }),
    remove: remove.mutateAsync,
  };
}

// --------------------------------------------------------------------------- //
// Settings
// --------------------------------------------------------------------------- //
export function useAppSettings() {
  const queryClient = useQueryClient();
  const key = ['app-settings'];

  const query = useQuery({ queryKey: key, queryFn: store.fetchSettings, staleTime: 30_000 });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const saveOne = useMutation({
    mutationFn: ({ key: settingKey, value }: { key: string; value: unknown }) =>
      store.putSetting(settingKey, value),
    onSuccess: invalidate,
  });

  const saveMany = useMutation({
    mutationFn: (settings: Record<string, unknown>) => store.putSettings(settings),
    onSuccess: invalidate,
  });

  return {
    settings: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    /** Persist a single setting, e.g. `save('semaphore', {...})`. */
    save: (settingKey: string, value: unknown) => saveOne.mutateAsync({ key: settingKey, value }),
    saveAll: saveMany.mutateAsync,
  };
}

// --------------------------------------------------------------------------- //
// Users (admin only on the server side)
// --------------------------------------------------------------------------- //
export function useUsers(enabled = true) {
  const queryClient = useQueryClient();
  const key = ['users'];

  const query = useQuery({
    queryKey: key,
    queryFn: store.fetchUsers,
    staleTime: 15_000,
    enabled,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({ mutationFn: store.createUser, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { displayName?: string; role?: string; isActive?: boolean; password?: string };
    }) => store.updateUser(id, payload),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: store.deleteUser, onSuccess: invalidate });

  return {
    users: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create: create.mutateAsync,
    update: (id: string, payload: Parameters<typeof store.updateUser>[1]) =>
      update.mutateAsync({ id, payload }),
    remove: remove.mutateAsync,
  };
}

export type { AuthUser };