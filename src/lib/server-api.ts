/**
 * Client for the FreeShow SMS Manager receiver (server/app.py).
 *
 * The deployed app no longer talks to FreeShow directly — the Python bridge
 * pushes variable snapshots here, and variable edits made in the UI are
 * queued as commands that the bridge applies to FreeShow.
 */

import type { FreeShowVariable } from '../types/freeshow';

const APP_TOKEN_KEY = 'appToken';

export interface ServerHealth {
  ok: boolean;
  variableCount: number;
  lastSyncAt: string | null;
  source: string | null;
  pendingCommands: number;
  uptimeSeconds: number;
}

export interface VariablesSnapshot {
  variables: FreeShowVariable[];
  updatedAt: string | null;
  source: string | null;
}

export interface VariableCommand {
  ok: boolean;
  commandId: string;
  queuedAt: string;
}

function appToken(): string {
  return localStorage.getItem(APP_TOKEN_KEY) ?? '';
}

function appHeaders(): Record<string, string> {
  const token = appToken();
  return token ? { 'X-App-Token': token } : {};
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    if (body?.detail) return new Error(String(body.detail));
    if (body?.error) return new Error(String(body.error));
  } catch {
    // ignore body parse errors
  }
  return new Error(`${fallback} (HTTP ${res.status})`);
}

// In-memory cache of the last snapshot, used as a graceful fallback
// when the receiver is briefly unreachable.
let cachedVariables: FreeShowVariable[] = [];

export function getCachedServerVariables(): FreeShowVariable[] {
  return cachedVariables;
}

export async function getServerVariables(): Promise<FreeShowVariable[]> {
  const res = await fetch('/api/variables', { headers: appHeaders() });
  if (!res.ok) throw await parseError(res, 'Could not load variables from the server');
  const snapshot: VariablesSnapshot = await res.json();
  cachedVariables = Array.isArray(snapshot.variables) ? snapshot.variables : [];
  return cachedVariables;
}

export async function getServerHealth(): Promise<ServerHealth> {
  const res = await fetch('/api/health', { headers: appHeaders() });
  if (!res.ok) throw await parseError(res, 'Could not reach the receiver server');
  return res.json();
}

/**
 * Queue a variable edit. The bridge picks it up and applies it to FreeShow;
 * the change then syncs back through the normal snapshot flow.
 */
export async function postVariableCommand(
  variableId: string,
  value: string
): Promise<VariableCommand> {
  const res = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...appHeaders() },
    body: JSON.stringify({ variableId, value }),
  });
  if (!res.ok) throw await parseError(res, 'Could not queue the variable change');
  return res.json();
}

export async function postVariableCommands(
  updates: Array<{ id: string; value: string }>
): Promise<VariableCommand[]> {
  const results: VariableCommand[] = [];
  for (const update of updates) {
    results.push(await postVariableCommand(update.id, update.value));
  }
  return results;
}

export function getAppToken(): string {
  return appToken();
}

export function setAppToken(token: string): void {
  if (token.trim()) localStorage.setItem(APP_TOKEN_KEY, token.trim());
  else localStorage.removeItem(APP_TOKEN_KEY);
}

/**
 * Convenience object so callers can use a single import namespace,
 * mirroring the shape of the old `freeshowAPI` client.
 */
export const serverApi = {
  getServerVariables,
  getServerHealth,
  postVariableCommand,
  postVariableCommands,
  getCachedServerVariables,
  getAppToken,
  setAppToken,
};
