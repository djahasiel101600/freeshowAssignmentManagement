import { useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import {
  DATA_KINDS,
  exportBundle,
  applyBundle,
  parseImportText,
  readFileAsText,
  downloadJson,
  countStoredData,
  writeStoredData,
  type DataCounts,
  type DataKind,
  type BackupBundle,
} from '../lib/backup';
import { Database, Download, Upload, Package, FileDown, FileUp } from 'lucide-react';

export function DataManager() {
  const toast = useToast();
  const [counts, setCounts] = useState<DataCounts>(countStoredData);
  const [busy, setBusy] = useState<string | null>(null);
  const allImportRef = useRef<HTMLInputElement>(null);
  const importRefs = useRef<Record<DataKind, HTMLInputElement | null>>({
    templates: null,
    contacts: null,
    rules: null,
    logs: null,
  });

  const refresh = () => setCounts(countStoredData());

  const handleExportAll = () => {
    const bundle = exportBundle(DATA_KINDS.map((d) => d.kind));
    downloadJson(bundle, 'freeshow-sms-backup');
    toast.success('Full backup downloaded as a JSON file.', { title: 'Backup exported' });
  };

  const handleExportSection = (kind: DataKind) => {
    const info = DATA_KINDS.find((d) => d.kind === kind)!;
    const bundle = exportBundle([kind]);
    downloadJson(bundle, info.filename);
    toast.success(`"${info.label}" exported to a JSON file.`, { title: 'Section exported' });
  };

  const replaceSectionFromBundle = (
    bundle: BackupBundle,
    kind: DataKind,
    label: string
  ): boolean => {
    const raw = bundle.sections?.[kind];
    if (!Array.isArray(raw) || raw.length === 0) {
      toast.error(`The file did not contain any ${label.toLowerCase()}.`, {
        title: 'Nothing to import',
      });
      return false;
    }
    writeStoredData(kind, raw);
    refresh();
    toast.success(`Replaced your ${label.toLowerCase()} with ${raw.length} item(s) from the file.`, {
      title: `${label} imported`,
    });
    return true;
  };

  const handleImportSection = async (kind: DataKind, file: File) => {
    setBusy(kind);
    try {
      const info = DATA_KINDS.find((d) => d.kind === kind)!;
      const text = await readFileAsText(file);
      const { bundle, array } = parseImportText(text);

      if (array !== null) {
        if (array.length === 0) {
          toast.error(`The file contained no ${info.label.toLowerCase()}.`, {
            title: 'Nothing to import',
          });
          return;
        }
        writeStoredData(kind, array);
        refresh();
        toast.success(`Replaced your ${info.label.toLowerCase()} with ${array.length} item(s) from the file.`, {
          title: `${info.label} imported`,
        });
      } else if (bundle) {
        replaceSectionFromBundle(bundle, kind, info.label);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed.', {
        title: 'Import failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleImportAll = async (file: File) => {
    setBusy('all');
    try {
      const text = await readFileAsText(file);
      const { bundle } = parseImportText(text);

      if (!bundle) {
        toast.error('Please choose a full backup file (Export All) for a full restore.', {
          title: 'Expected a backup file',
        });
        return;
      }

      const kinds = DATA_KINDS.map((d) => d.kind);
      const applied = applyBundle(bundle, kinds);

      if (applied.length === 0) {
        toast.error('The backup file did not contain any data sections.', {
          title: 'Nothing to import',
        });
        return;
      }

      refresh();
      const labels = applied
        .map((k) => DATA_KINDS.find((d) => d.kind === k)?.label)
        .filter(Boolean)
        .join(', ');
      toast.success(`Restored ${applied.length} section(s): ${labels}`, {
        title: 'Backup restored',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed.', {
        title: 'Import failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const triggerInput = (ref: HTMLInputElement | null) => {
    if (ref) {
      ref.value = '';
      ref.click();
    }
  };

  return (
<Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-lg">Data Management</CardTitle>
              <CardDescription>
                Export your data to JSON files, or restore from a backup on this device.
              </CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleExportAll}>
              <Package className="h-4 w-4 mr-2" />
              Export All
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => triggerInput(allImportRef.current)}
            >
              <Upload className="h-4 w-4 mr-2" />
              Import Backup
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
          }}
          aria-label="Import full backup file"
        />
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Importing replaces the current data in that category. Data used by imported contacts,
          rules, and message templates will reflect the file the next time you open those tabs.
        </p>
        <div className="divide-y">
          {DATA_KINDS.map((info) => (
            <div
              key={info.kind}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="font-medium">{info.label}</p>
                <p className="text-xs text-muted-foreground">
                  {info.description} · {counts[info.kind]} saved
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExportSection(info.kind)}
                >
                  <FileDown className="h-4 w-4 mr-2" />
                  Export
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => triggerInput(importRefs.current[info.kind])}
                >
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
                  }}
                  aria-label={`Import ${info.label} file`}
                />
              </div>
            </div>
          ))}
        </div>
<div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
          <Download className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Tip: an "Export" saves only that category (compatible with the matching "Import"),
            while "Export All" saves everything into one file that "Import Backup" restores.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}