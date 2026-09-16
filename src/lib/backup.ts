/**
 * Data backup & transfer utilities.
 *
 * All app data lives in localStorage. These helpers read/write the raw
 * payloads so the Settings tab can export them to JSON files and restore
 * them later (on this device or another one).
 */

export type DataKind = 'templates' | 'contacts' | 'rules' | 'logs';

export interface DataKindInfo {
  kind: DataKind;
  label: string;
  description: string;
  storageKey: string;
  filename: string;
}

export const DATA_KINDS: DataKindInfo[] = [
  {
    kind: 'templates',
    label: 'Message Templates',
    description: 'Saved SMS message templates',
    storageKey: 'messageTemplates',
    filename: 'message-templates',
  },
  {
    kind: 'contacts',
    label: 'Contact List',
    description: 'Contacts and nicknames',
    storageKey: 'freeshow-contacts',
    filename: 'contacts',
  },
  {
    kind: 'rules',
    label: 'Conditional Rules',
    description: 'Conditional message rules',
    storageKey: 'conditionalRules',
    filename: 'conditional-rules',
  },
  {
    kind: 'logs',
    label: 'Message History',
    description: 'Sent message history',
    storageKey: 'freeshow-message-logs',
    filename: 'message-history',
  },
];

const KIND_BY_KEY: Record<string, DataKind> = Object.fromEntries(
  DATA_KINDS.map((info) => [info.storageKey, info.kind])
);

export const BUNDLE_APP = 'freeshow-sms-manager';
export const BUNDLE_VERSION = 1;

export interface BackupBundle {
  app: typeof BUNDLE_APP;
  version: number;
  exportedAt: string;
  sections: Partial<Record<DataKind, unknown[]>>;
}

export interface DataCounts {
  templates: number;
  contacts: number;
  rules: number;
  logs: number;
}

function infoFor(kind: DataKind): DataKindInfo {
  const info = DATA_KINDS.find((d) => d.kind === kind);
  if (!info) throw new Error(`Unknown data kind: ${kind}`);
  return info;
}

export function readStoredData(kind: DataKind): unknown[] {
  const { storageKey } = infoFor(kind);
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeStoredData(kind: DataKind, data: unknown[]): void {
  const { storageKey } = infoFor(kind);
  localStorage.setItem(storageKey, JSON.stringify(data));
}

export function countStoredData(): DataCounts {
  return {
    templates: readStoredData('templates').length,
    contacts: readStoredData('contacts').length,
    rules: readStoredData('rules').length,
    logs: readStoredData('logs').length,
  };
}

/** Build a bundle containing just the requested sections. */
export function exportBundle(sections: DataKind[]): BackupBundle {
  const entries = sections as DataKind[];
  const bundle: BackupBundle = {
    app: BUNDLE_APP,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    sections: {},
  };
  for (const kind of entries) {
    bundle.sections[kind] = readStoredData(kind);
  }
  return bundle;
}

/**
 * Apply a bundle's sections back to localStorage.
 * Returns the section names that were applied (and not empty).
 */
export function applyBundle(bundle: BackupBundle, sections: DataKind[]): DataKind[] {
  const applied: DataKind[] = [];
  for (const kind of sections) {
    const raw = bundle.sections?.[kind];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    writeStoredData(kind, raw);
    applied.push(kind);
  }
  return applied;
}

/**
 * Parse an imported JSON string. The file can be either:
 *   - a full backup bundle (has a `sections` map)
 *   - or a plain array for a single section
 * Returns the bundle + (when a plain array was given) which kind it maps to.
 */
export function parseImportText(
  text: string
): { bundle: BackupBundle | null; array: unknown[] | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }

  if (Array.isArray(parsed)) {
    return { bundle: null, array: parsed };
  }

  if (parsed && typeof parsed === 'object') {
    const candidate = parsed as Record<string, unknown>;
    if (candidate.sections && typeof candidate.sections === 'object') {
      return {
        bundle: {
          app: (candidate.app as BackupBundle['app']) || BUNDLE_APP,
          version: typeof candidate.version === 'number' ? candidate.version : BUNDLE_VERSION,
          exportedAt:
            typeof candidate.exportedAt === 'string'
              ? candidate.exportedAt
              : new Date().toISOString(),
          sections: candidate.sections as BackupBundle['sections'],
        },
        array: null,
      };
    }
  }

  throw new Error('Unrecognized file format. Export a section or full backup from the app first.');
}

/** Trigger a browser download of a JSON file. */
export function downloadJson(data: unknown, baseFilename: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${baseFilename}-${stamp}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Read a File object as a UTF-8 string. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsText(file);
  });
}

export { KIND_BY_KEY };