import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as store from '../lib/store-api';
import { semaphoreAPI } from '../lib/semaphore-api';
import { webhookAPI, type WebhookConfig } from '../lib/webhook-api';
import { loadGlobalLayout, saveGlobalLayout, type MessageLayout } from '../lib/message-utils';
import type { ConditionalRule, SavedTemplate } from '../types/templates';
import type { AuthUser } from '../types/auth';

const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  url: '',
  enabled: false,
  retryCount: 3,
  retryDelay: 1000,
  includeAllVariables: true,
  batchUpdates: false,
  batchWindow: 2000,
};

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
  const settings = query.data ?? null;

  const saveOne = useMutation({
    mutationFn: ({ key: settingKey, value }: { key: string; value: unknown }) =>
      store.putSetting(settingKey, value),
    onSuccess: invalidate,
  });

  const saveMany = useMutation({
    mutationFn: (settings: Record<string, unknown>) => store.putSettings(settings),
    onSuccess: invalidate,
  });

  // `mutateAsync` is referentially stable in react-query, so the returned `save`
  // is too. Callers put it in effect dependency arrays; a new function every
  // render would make those effects fire in a loop.
  const { mutateAsync: saveOneAsync } = saveOne;
  const save = useCallback(
    (settingKey: string, value: unknown) => saveOneAsync({ key: settingKey, value }),
    [saveOneAsync]
  );

  // Activate the integration clients (Semaphore + n8n webhook) from the saved
  // settings. This must NOT live only in the Settings panel: users can send
  // messages or push variables without ever opening that tab, and on a fresh
  // device the modules would otherwise start with empty configs.
  useEffect(() => {
    if (!settings) return;
    const semaphore = settings.semaphore as { apiKey?: string; senderName?: string } | undefined;
    if (semaphore) {
      semaphoreAPI.setConfig({
        apiKey: semaphore.apiKey ?? '',
        senderName: semaphore.senderName ?? 'ChurchName',
      });
    }
    const webhook = settings.webhook as Partial<WebhookConfig> | undefined;
    webhookAPI.setConfig({ ...DEFAULT_WEBHOOK_CONFIG, ...(webhook ?? {}) });
  }, [settings]);

  return {
    settings,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    /** Persist a single setting, e.g. `save('semaphore', {...})`. */
    save,
    saveAll: saveMany.mutateAsync,
  };
}

// --------------------------------------------------------------------------- //
// Global message layout (header/footer)
// --------------------------------------------------------------------------- //
/**
 * The saved global header/footer. Hydrates the `message-utils` module cache
 * from the server setting and persists edits back (debounced, and only when
 * the value actually differs from what the server has).
 */
export function useMessageLayout() {
  const { settings, save } = useAppSettings();
  const [layout, setLayoutState] = useState<MessageLayout>(() => loadGlobalLayout());
  const hydratedRef = useRef(false);
  // What the server last had (or was just hydrated with), so the persist
  // effect neither re-writes on mount nor fires per keystroke.
  const lastSavedRef = useRef<string | null>(null);

  useEffect(() => {
    if (hydratedRef.current || !settings) return;
    hydratedRef.current = true;
    const stored = settings.message_layout as Partial<MessageLayout> | undefined;
    const next: MessageLayout = {
      header: typeof stored?.header === 'string' ? stored.header : '',
      footer: typeof stored?.footer === 'string' ? stored.footer : '',
    };
    lastSavedRef.current = JSON.stringify(next);
    saveGlobalLayout(next); // keep the module cache in sync for other callers
    setLayoutState(next);
  }, [settings]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const snapshot = JSON.stringify(layout);
    if (snapshot === lastSavedRef.current) return;
    saveGlobalLayout(layout);
    const timer = window.setTimeout(() => {
      lastSavedRef.current = snapshot;
      void save('message_layout', layout).catch(() => {
        // Reverted cache stays in place; the next edit retries the write.
        lastSavedRef.current = null;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [layout, save]);

  return { layout, setLayout: setLayoutState };
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