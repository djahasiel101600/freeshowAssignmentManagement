import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import { fetchBackup, importBackup } from '../lib/store-api';
import { downloadJson, readFileAsText, parseBackupFile, type BackupBundle, type DataKind } from '../lib/backup';
import { Database, Package, FileDown, FileUp, Loader2, RefreshCw } from 'lucide-react';

/**
 * Data backup & restore — now server-side.
 *
 * Everything lives in the receiver's database, so "Export" downloads what the
 * server reports and "Import" replaces server sections from a JSON file. The
 * download/import file format is unchanged from the localStorage era.
 */

interface DataKindInfo {
  kind: DataKind;
  label: string;
  description: string;
  filename: string;
}

const DATA_KINDS: DataKindInfo[] = [
  { kind: 'templates', label: 'Message Templates', description: 'Saved SMS message templates', filename: 'message-templates' },
  { kind: 'contacts', label: 'Contact List', description: 'Contacts and nicknames', filename: 'contacts' },
  { kind: 'rules', label: 'Conditional Rules', description: 'Conditional message rules', filename: 'conditional-rules' },
  { kind: 'logs', label: 'Message History', description: 'Sent message history', filename: 'message-history' },
  { kind: 'schedules', label: 'Schedule Rules', description: 'Recurring service-date rules per variable', filename: 'schedule-rules' },
];

export function DataManager() {
  const toast = useToast();
  const [bundle, setBundle] = useState<BackupBundle | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const allImportRef = useRef<HTMLInputElement>(null);
  const importRefs = useRef<Record<DataKind, HTMLInputElement | null>>({
    templates: null,
    contacts: null,
    rules: null,
    logs: null,
    schedules: null,
  });

  const refresh = useCallback(async () => {
    try {
      setBundle(await fetchBackup());
    } catch {
      // Leave the previous bundle in place; counts just stay stale.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = ((): Record<DataKind, number> => {
    const sections = (bundle?.sections ?? {}) as Record<string, unknown[]>;
    const count = (kind: DataKind) => (Array.isArray(sections[kind]) ? sections[kind].length : 0);
    return {
      templates: count('templates'),
      contacts: count('contacts'),
      rules: count('rules'),
      logs: count('logs'),
      schedules: count('schedules'),
    };
  })();

  const handleExportAll = async () => {
    setBusy('all');
    try {
      const current = await fetchBackup();
      downloadJson(current, 'freeshow-sms-backup');
      toast.success('Full backup downloaded as a JSON file.', { title: 'Backup exported' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.', { title: 'Export failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleExportSection = async (kind: DataKind) => {
    const info = DATA_KINDS.find((d) => d.kind === kind)!;
    setBusy(kind);
    try {
      const current = await fetchBackup();
      const sections = (current.sections ?? {}) as Record<string, unknown[]>;
      const rows = Array.isArray(sections[kind]) ? sections[kind] : [];
      const single = { ...current, sections: { [kind]: rows } };
      downloadJson(single, info.filename);
      toast.success(`"${info.label}" exported to a JSON file.`, { title: 'Section exported' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.', { title: 'Export failed' });
    } finally {
      setBusy(null);
    }
  };

  const applyImport = async (kind: DataKind | 'all', payload: BackupBundle) => {
    const applied = await importBackup(payload);
    const total = Object.values(applied).reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
    const label = kind === 'all' ? 'backup' : DATA_KINDS.find((d) => d.kind === kind)?.label ?? kind;
    toast.success(`Replaced the ${label.toLowerCase()} with ${total} item(s) from the file.`, {
      title: kind === 'all' ? 'Backup imported' : 'Import complete',
    });
    await refresh();
  };

  const handleImportSection = async (kind: DataKind, file: File) => {
    const info = DATA_KINDS.find((d) => d.kind === kind)!;
    setBusy(kind);
    try {
      const text = await readFileAsText(file);
      const parsed = parseBackupFile(text, kind);
      const rows = Array.isArray(parsed.sections[kind]) ? parsed.sections[kind] : [];
      if (rows.length === 0) {
        toast.error(`The file did not contain any ${info.label.toLowerCase()}.`, {
          title: 'Nothing to import',
        });
        return;
      }
      await applyImport(kind, { ...parsed, sections: { [kind]: rows } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed.', { title: 'Import failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleImportAll = async (file: File) => {
    setBusy('all');
    try {
      const text = await readFileAsText(file);
      const parsed = parseBackupFile(text);
      await applyImport('all', parsed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed.', { title: 'Import failed' });
    } finally {
      setBusy(null);
    }
  };

  const triggerInput = (element: HTMLInputElement | null) => element?.click();

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Database className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Data Backup &amp; Restore</CardTitle>
              <CardDescription>
                Your data is stored in the receiver&apos;s database. Export it to a JSON file for safekeeping,
                or restore sections from a previous backup.
              </CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleExportAll} disabled={busy !== null}>
              {busy === 'all' ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Package className="h-4 w-4 mr-2" />
              )}
              Export All
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => triggerInput(allImportRef.current)}
            >
              <FileUp className="h-4 w-4 mr-2" />
              Import Backup
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
              <span className="sr-only">Refresh counts</span>
            </Button>
          </div>
        </div>
        <input
          ref={allImportRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportAll(file);
            e.target.value = '';
          }}
          aria-label="Import full backup file"
        />
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Importing replaces the current data in that category on the server. Everything you import is
          visible to every signed-in user of this receiver.
        </p>
        <div className="divide-y">
          {DATA_KINDS.map((info) => (
            <div key={info.kind} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{info.label}</p>
                <p className="text-xs text-muted-foreground">
                  {info.description} · {counts[info.kind]} on the server
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleExportSection(info.kind)} disabled={busy !== null}>
                  <FileDown className="h-4 w-4 mr-2" />
                  Export
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => triggerInput(importRefs.current[info.kind])}>
                  <FileUp className="h-4 w-4 mr-2" />
                  Import
                </Button>
                <input
                  ref={(el) => {
                    importRefs.current[info.kind] = el;
                  }}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportSection(info.kind, file);
                    e.target.value = '';
                  }}
                  aria-label={`Import ${info.label} file`}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
          <p>
            Tip: an "Export" saves only that category (compatible with the matching "Import"), while
            "Export All" saves everything into one file that "Import Backup" restores.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
