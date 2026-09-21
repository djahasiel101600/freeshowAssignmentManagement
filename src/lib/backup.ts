/**
 * Backup-file helpers.
 *
 * The data itself lives in the receiver's database; these utilities only deal
 * with the JSON files the Settings tab downloads and re-imports. The bundle
 * shape (app / version / exportedAt / sections) is unchanged from the era when
 * everything lived in localStorage, so old backup files still import.
 */

export type DataKind = 'templates' | 'contacts' | 'rules' | 'logs' | 'schedules';

export interface BackupBundle {
  app: string;
  version: number;
  exportedAt: string;
  sections: Record<string, unknown[]>;
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

/**
 * Parse an imported JSON string. The file can be either:
 *   - a full backup bundle (has a `sections` map), or
 *   - a plain array — which only makes sense when a single section was asked for.
 * A bare array without a target kind is rejected so "Import Backup" cannot
 * wipe sections by accident.
 */
export function parseBackupFile(text: string, kind?: DataKind): BackupBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }

  if (Array.isArray(parsed)) {
    if (!kind) {
      throw new Error('This file holds only one section. Use the matching "Import" button instead of "Import Backup".');
    }
    return {
      app: 'freeshow-sms-manager',
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { [kind]: parsed },
    };
  }

  if (parsed && typeof parsed === 'object') {
    const candidate = parsed as Record<string, unknown>;
    if (candidate.sections && typeof candidate.sections === 'object') {
      return {
        app: typeof candidate.app === 'string' ? candidate.app : 'freeshow-sms-manager',
        version: typeof candidate.version === 'number' ? candidate.version : 1,
        exportedAt:
          typeof candidate.exportedAt === 'string' ? candidate.exportedAt : new Date().toISOString(),
        sections: candidate.sections as Record<string, unknown[]>,
      };
    }
  }

  throw new Error('Unrecognized file format. Export a section or full backup from the app first.');
}
