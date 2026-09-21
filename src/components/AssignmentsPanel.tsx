import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import { useAssignments, useAssignmentChanges } from '../hooks/useScheduleData';
import { useFreeShowVariables } from '../hooks/useFreeShowVariables';
import {
  CalendarClock, History, Plus, Search, Trash2, UserCheck, AlertCircle, Loader2,
} from 'lucide-react';

/**
 * Assignment ledger browser.
 *
 * The bridge records assignments automatically whenever a tracked FreeShow
 * variable changes; this panel is for reading that history and for correcting
 * it by hand (a schedule decided outside FreeShow, a typo, etc.).
 */
export function AssignmentsPanel() {
  const toast = useToast();
  const { variables } = useFreeShowVariables();

  const [variable, setVariable] = useState('');
  const [person, setPerson] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters = useMemo(
    () => ({
      variable: variable || undefined,
      person: person || undefined,
      from: from || undefined,
      to: to || undefined,
    }),
    [variable, person, from, to]
  );

  const { assignments, isLoading, error, recordAssignment, removeAssignment, refetch } =
    useAssignments(filters);
  const { changes } = useAssignmentChanges({ variable: variable || undefined, limit: 50 });

  // --- manual entry form -------------------------------------------------- //
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: '', scheduleDate: '', variableId: '', value: '', note: '' });
  const [saving, setSaving] = useState(false);

  const variableOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { id: string; name: string }[] = [];
    for (const item of variables) {
      if (!item.name || seen.has(item.name)) continue;
      seen.add(item.name);
      options.push({ id: item.id, name: item.name });
    }
    // Variables that only exist in the ledger (e.g. renamed in FreeShow).
    for (const row of assignments) {
      if (seen.has(row.variableName)) continue;
      seen.add(row.variableName);
      options.push({ id: row.variableId, name: row.variableName });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }, [variables, assignments]);

  const submit = async () => {
    const name = variableOptions.find((v) => v.id === form.variableId)?.name;
    if (!form.variableId || !name) {
      toast.error('Pick the FreeShow variable this assignment belongs to.', {
        title: 'Variable required',
      });
      return;
    }
    if (!form.value.trim()) {
      toast.error('Enter who is assigned.', { title: 'Value required' });
      return;
    }
    setSaving(true);
    try {
      await recordAssignment({
        date: form.date || undefined,
        scheduleDate: form.scheduleDate || undefined,
        variableId: form.variableId,
        variableName: name,
        value: form.value.trim(),
        note: form.note.trim(),
      });
      toast.success('Assignment saved to the ledger.', { title: 'Recorded' });
      setForm({ date: '', scheduleDate: '', variableId: '', value: '', note: '' });
      setShowForm(false);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the assignment.', {
        title: 'Save failed',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Remove the ${label} assignment from the ledger?`)) return;
    try {
      await removeAssignment(id);
      toast.info('Assignment removed.', { title: 'Deleted' });
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.', {
        title: 'Delete failed',
      });
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Schedule History</h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <UserCheck className="h-3.5 w-3.5" />
            {assignments.length} record{assignments.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button onClick={() => setShowForm((v) => !v)} variant={showForm ? 'outline' : 'default'}>
          <Plus className="h-4 w-4 mr-2" />
          {showForm ? 'Cancel' : 'Record assignment'}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Record an assignment by hand</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="assign-date">Date</Label>
              <Input
                id="assign-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Leave empty for today.</p>
            <div className="space-y-2">
              <Label htmlFor="assign-schedule-date">Service date (optional)</Label>
              <Input
                id="assign-schedule-date"
                type="date"
                value={form.scheduleDate}
                onChange={(e) => setForm({ ...form, scheduleDate: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Pin the date this assignment is for. Leave empty to derive it from the recurring rule.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-variable">FreeShow variable</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-variable">FreeShow variable</Label>
              <select
                id="assign-variable"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.variableId}
                onChange={(e) => setForm({ ...form, variableId: e.target.value })}
              >
                <option value="">Select a variable…</option>
                {variableOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-value">Assigned to</Label>
              <Input
                id="assign-value"
                value={form.value}
                placeholder="e.g. Sis. Mary"
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-note">Note (optional)</Label>
              <Input
                id="assign-note"
                value={form.note}
                placeholder="Why this was recorded manually"
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Button onClick={submit} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                Save to ledger
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid gap-3 py-4 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="filter-variable" className="text-xs">Variable</Label>
            <select
              id="filter-variable"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={variable}
              onChange={(e) => setVariable(e.target.value)}
            >
              <option value="">All variables</option>
              {variableOptions.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-person" className="text-xs">Person</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="filter-person"
                className="h-9 pl-7"
                value={person}
                placeholder="Search name"
                onChange={(e) => setPerson(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-from" className="text-xs">From</Label>
            <Input
              id="filter-from"
              type="date"
              className="h-9"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-to" className="text-xs">To</Label>
            <Input
              id="filter-to"
              type="date"
              className="h-9"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error instanceof Error ? error.message : 'Could not load the ledger.'}</span>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="h-5 w-5" />
            Assignment ledger
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the ledger…
            </p>
          ) : assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded yet. The bridge writes entries automatically when tracked variables
              change, or you can add one by hand above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 pr-3 font-medium">Service date</th>
                    <th className="py-2 pr-3 font-medium">Variable</th>
                    <th className="py-2 pr-3 font-medium">Assigned to</th>
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 pr-3 font-medium">Note</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap font-medium">{row.date}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {row.effectiveDate ?? row.date}
                          {row.scheduleSource === 'pinned' && (
                            <span
                              className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                              title="This date was pinned on the entry itself."
                            >
                              pinned
                            </span>
                          )}
                          {row.scheduleSource === 'rule' && (
                            <span
                              className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400"
                              title="Derived from the variable's recurring schedule."
                            >
                              rule
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{row.variableName}</td>
                      <td className="py-2 pr-3">{row.contactName || row.value}</td>
                      <td className="py-2 pr-3">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {row.source}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{row.note}</td>
                      <td className="py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${row.value} on ${row.date}`}
                          onClick={() => void handleDelete(row.id, `${row.value} (${row.date})`)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {changes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              Recent changes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {changes.slice(0, 20).map((change) => (
              <div key={change.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm">
                <span className="text-xs text-muted-foreground">{change.changedAt.slice(0, 10)}</span>
                <span className="font-medium">{change.variableName}</span>
                <span className="text-muted-foreground">
                  {change.previousValue || '(empty)'} → {change.newValue || '(empty)'}
                </span>
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {change.source}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
