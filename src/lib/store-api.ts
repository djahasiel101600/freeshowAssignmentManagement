/**
 * Typed bindings for the receiver API.
 *
 * This is the single place the UI talks to the database through. Everything
 * that used to be `localStorage` (contacts, templates, rules, logs, settings,
 * backups) now resolves here, which is what makes the data survive a browser
 * reset and follow the account across devices.
 */

import { api, withQuery } from './api';
import type { Contact } from '../types/contacts';
import type { MessageLog } from '../types/messages';
import type {
  AssignmentChange,
  AssignmentRecord,
  AssignmentTrackingConfig,
  BackupBundle,
  RotationOverviewRow,
  RotationPersonSummary,
  RotationReport,
} from '../types/assignments';
import type { AuthSessionRow, AuthUser } from '../types/auth';
import type { ConditionalRule, SavedTemplate } from '../types/templates';

// --------------------------------------------------------------------------- //
// Settings
// --------------------------------------------------------------------------- //
export interface SemaphoreSettings {
  apiKey: string;
  senderName: string;
}

export interface WebhookSettings {
  url: string;
  enabled: boolean;
  retryCount: number;
  retryDelay: number;
  includeAllVariables: boolean;
  batchUpdates: boolean;
  batchWindow: number;
}

export interface ComposerDraft {
  messageTemplate: string;
  variableTitlePairs: Array<{ id: string; variableName: string; title: string; displayName?: string }>;
  templateId: string | null;
}

export interface AppSettings {
  semaphore: SemaphoreSettings;
  webhook: WebhookSettings;
  assignment_tracking: AssignmentTrackingConfig;
  composer_draft: ComposerDraft;
  message_layout?: Record<string, unknown>;
  variable_groups?: unknown;
  [key: string]: unknown;
}

export async function fetchSettings(): Promise<AppSettings> {
  const data = await api.get<{ settings: AppSettings }>('/api/settings');
  return data.settings;
}

/** Store one setting; `value` is the whole object for that key. */
export async function putSetting<T = unknown>(key: string, value: T): Promise<T> {
  const data = await api.put<{ value: T }>(`/api/settings/${encodeURIComponent(key)}`, { value });
  return data.value;
}

export async function putSettings(settings: Record<string, unknown>): Promise<AppSettings> {
  const data = await api.post<{ settings: AppSettings }>('/api/settings', { settings });
  return data.settings;
}

export async function fetchTracking(): Promise<AssignmentTrackingConfig> {
  const data = await api.get<{ tracking: AssignmentTrackingConfig }>('/api/settings/tracking');
  return data.tracking;
}

export async function putTracking(tracking: AssignmentTrackingConfig): Promise<AssignmentTrackingConfig> {
  const data = await api.put<{ tracking: AssignmentTrackingConfig }>('/api/settings/tracking', {
    tracking,
  });
  return data.tracking;
}

// --------------------------------------------------------------------------- //
// Collections
// --------------------------------------------------------------------------- //
export async function fetchContacts(): Promise<Contact[]> {
  const data = await api.get<{ contacts: Contact[] }>('/api/contacts');
  return data.contacts;
}

export async function createContact(payload: Partial<Contact>): Promise<Contact> {
  const data = await api.post<{ item: Contact }>('/api/contacts', payload);
  return data.item;
}

export async function updateContact(id: string, payload: Partial<Contact>): Promise<Contact> {
  const data = await api.patch<{ item: Contact }>(`/api/contacts/${id}`, payload);
  return data.item;
}

export async function deleteContact(id: string): Promise<void> {
  await api.delete(`/api/contacts/${id}`);
}

export async function addNickname(contactId: string, nickname: string): Promise<Contact> {
  const data = await api.post<{ item: Contact }>(`/api/contacts/${contactId}/nicknames`, { nickname });
  return data.item;
}

export async function removeNickname(contactId: string, nickname: string): Promise<Contact> {
  const data = await api.delete<{ item: Contact }>(`/api/contacts/${contactId}/nicknames`, {
    nickname,
  });
  return data.item;
}

export async function fetchLogs(limit = 1000): Promise<MessageLog[]> {
  const data = await api.get<{ logs: MessageLog[] }>(withQuery('/api/logs', { limit }));
  return data.logs;
}

/** Append one or many logs (the composer writes in batches). */
export async function appendLogs(logs: Array<Partial<MessageLog>>): Promise<MessageLog[]> {
  if (logs.length === 0) return [];
  const data = await api.post<{ logs?: MessageLog[]; item?: MessageLog }>('/api/logs', { logs });
  if (data.logs) return data.logs;
  return data.item ? [data.item] : [];
}

export async function clearLogs(): Promise<number> {
  const data = await api.delete<{ removed: number }>('/api/logs');
  return data.removed;
}

// --------------------------------------------------------------------------- //
// Templates + conditional rules
// --------------------------------------------------------------------------- //
export async function fetchTemplates(): Promise<SavedTemplate[]> {
  const data = await api.get<{ templates: SavedTemplate[] }>('/api/templates');
  return data.templates;
}

export async function createTemplate(payload: Partial<SavedTemplate>): Promise<SavedTemplate> {
  const data = await api.post<{ item: SavedTemplate }>('/api/templates', payload);
  return data.item;
}

export async function updateTemplate(
  id: string,
  payload: Partial<SavedTemplate>
): Promise<SavedTemplate> {
  const data = await api.patch<{ item: SavedTemplate }>(`/api/templates/${id}`, payload);
  return data.item;
}

export async function deleteTemplate(id: string): Promise<void> {
  await api.delete(`/api/templates/${id}`);
}

export async function fetchRules(): Promise<ConditionalRule[]> {
  const data = await api.get<{ rules: ConditionalRule[] }>('/api/rules');
  return data.rules;
}

export async function createRule(payload: Partial<ConditionalRule>): Promise<ConditionalRule> {
  const data = await api.post<{ item: ConditionalRule }>('/api/rules', payload);
  return data.item;
}

export async function updateRule(
  id: string,
  payload: Partial<ConditionalRule>
): Promise<ConditionalRule> {
  const data = await api.patch<{ item: ConditionalRule }>(`/api/rules/${id}`, payload);
  return data.item;
}

export async function deleteRule(id: string): Promise<void> {
  await api.delete(`/api/rules/${id}`);
}

// --------------------------------------------------------------------------- //
// Users + sessions
// --------------------------------------------------------------------------- //
export async function fetchUsers(): Promise<AuthUser[]> {
  const data = await api.get<{ users: AuthUser[] }>('/api/users');
  return data.users;
}

export async function createUser(payload: {
  username: string;
  password: string;
  displayName?: string;
  role?: string;
}): Promise<AuthUser> {
  const data = await api.post<{ user: AuthUser }>('/api/users', payload);
  return data.user;
}

export async function updateUser(
  id: string,
  payload: { displayName?: string; role?: string; isActive?: boolean; password?: string }
): Promise<AuthUser> {
  const data = await api.patch<{ user: AuthUser }>(`/api/users/${id}`, payload);
  return data.user;
}

export async function deleteUser(id: string): Promise<void> {
  await api.delete(`/api/users/${id}`);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.post('/api/auth/password', { currentPassword, newPassword });
}

export async function fetchSessions(): Promise<AuthSessionRow[]> {
  const data = await api.get<{ sessions: AuthSessionRow[] }>('/api/sessions');
  return data.sessions;
}

// --------------------------------------------------------------------------- //
// Assignments + rotation
// --------------------------------------------------------------------------- //
export async function fetchAssignments(params: {
  from?: string;
  to?: string;
  variable?: string;
  person?: string;
  limit?: number;
} = {}): Promise<AssignmentRecord[]> {
  const data = await api.get<{ assignments: AssignmentRecord[] }>(withQuery('/api/assignments', params));
  return data.assignments;
}

export async function createAssignment(payload: {
  date?: string;
  variableId: string;
  variableName: string;
  value: string;
  note?: string;
}): Promise<AssignmentRecord> {
  const data = await api.post<{ item: AssignmentRecord }>('/api/assignments', payload);
  return data.item;
}

export async function deleteAssignment(id: string): Promise<void> {
  await api.delete(`/api/assignments/${id}`);
}

export async function fetchAssignmentChanges(params: {
  variable?: string;
  person?: string;
  from?: string;
  to?: string;
  limit?: number;
} = {}): Promise<AssignmentChange[]> {
  const data = await api.get<{ changes: AssignmentChange[] }>(
    withQuery('/api/assignments/changes', params)
  );
  return data.changes;
}

export async function fetchTrackedVariables(): Promise<string[]> {
  const data = await api.get<{ variables: string[] }>('/api/assignments/variables');
  return data.variables;
}

export async function fetchRotationVariables(): Promise<{ name: string; turnCount: number }[]> {
  const data = await api.get<{ variables: { name: string; turnCount: number }[] }>(
    '/api/rotation/variables'
  );
  return data.variables;
}

/** Full per-variable report, or an overview of every tracked variable. */
export async function fetchRotationSummary(variable?: string, lookbackDays = 730): Promise<{
  report?: RotationReport;
  reports?: RotationOverviewRow[];
}> {
  return api.get(
    withQuery('/api/rotation/summary', { variable, lookback_days: lookbackDays })
  );
}

export async function fetchRotationPeople(
  variable?: string,
  limit = 100
): Promise<RotationPersonSummary[]> {
  const data = await api.get<{ people: RotationPersonSummary[] }>(
    withQuery('/api/rotation/people', { variable, limit })
  );
  return data.people;
}

// --------------------------------------------------------------------------- //
// Backup
// --------------------------------------------------------------------------- //
export async function fetchBackup(): Promise<BackupBundle> {
  return api.get<BackupBundle>('/api/backup');
}

export async function importBackup(bundle: BackupBundle): Promise<Record<string, number>> {
  const data = await api.post<{ applied: Record<string, number> }>('/api/backup', bundle);
  return data.applied;
}
