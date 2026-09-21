import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import { useRotation, useRotationVariables, useTracking } from '../hooks/useScheduleData';
import { ScheduleRulesCard, formatIsoDate } from './ScheduleRulesCard';
import type { CycleInfo, RotationOverviewRow } from '../types/assignments';
import {
  AlertCircle, CalendarClock, CheckCircle2, Loader2, RefreshCw, Repeat, Save, Users,
} from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Rotation analysis.
 *
 * Answers two questions from the assignment ledger: does a variable repeat on
 * a regular cycle, and who is expected next. The ledger itself is filled by
 * the bridge; this panel only reads what the receiver has already recorded.
 *
 * The dates used here are *service* dates: when a variable has a recurring
 * schedule (see the Recurring schedules card) each recorded entry is counted on
 * the service it was entered for.
 */

function describeCycle(cycle: CycleInfo | undefined | null): string {
  if (!cycle) return '—';
  if (cycle.rotationLength > 0 && cycle.sequenceRepeats) {
    const accuracy =
      cycle.sequenceAccuracy != null ? ` (${Math.round(cycle.sequenceAccuracy * 100)}%)` : '';
    return `${cycle.rotationLength}-person rotation${accuracy}`;
  }
  if (cycle.periodDays != null && cycle.periodLabel) {
    const consistency =
      cycle.consistency != null ? ` · ${Math.round(cycle.consistency * 100)}% regular` : '';
    return `~every ${cycle.periodLabel}${consistency}`;
  }
  return 'No cycle detected yet';
}

function CycleChips({ cycle }: { cycle: CycleInfo }) {
  const chips: { label: string; value: string; good?: boolean }[] = [];
  if (cycle.periodDays != null) {
    chips.push({ label: 'Cycle', value: cycle.periodLabel ?? `${cycle.periodDays}d`, good: cycle.isRegular });
  }
  if (cycle.gapMedian != null) chips.push({ label: 'Median gap', value: `${cycle.gapMedian}d` });
  if (cycle.gapStdev != null) chips.push({ label: 'Spread', value: `±${cycle.gapStdev}d`, good: cycle.gapConsistent });
  if (cycle.rotationLength > 0) chips.push({ label: 'Rotation', value: `${cycle.rotationLength} people` });
  if (cycle.sequenceAccuracy != null) {
    chips.push({
      label: 'Order accuracy',
      value: `${Math.round(cycle.sequenceAccuracy * 100)}%`,
      good: cycle.sequenceRepeats,
    });
  }
  if (chips.length === 0) {
    return <p className="text-sm text-muted-foreground">Not enough history yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
            chip.good === true && 'bg-green-500/10 text-green-600',
            chip.good === false && 'bg-yellow-500/10 text-yellow-600',
            chip.good === undefined && 'bg-muted text-muted-foreground'
          )}
        >
          {chip.label}: {chip.value}
        </span>
      ))}
    </div>
  );
}

function OverviewRow({ row, onOpen }: { row: RotationOverviewRow; onOpen: (name: string) => void }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/50">
      <td className="py-2 pr-3">
        <button className="font-medium hover:underline" onClick={() => onOpen(row.variableName)}>
          {row.variableName}
        </button>
      </td>
      <td className="py-2 pr-3 text-sm text-muted-foreground">{row.totalAssignments}</td>
      <td className="py-2 pr-3 text-sm text-muted-foreground">{row.distinctPeople}</td>
      <td className="py-2 pr-3 text-sm text-muted-foreground">{row.lastDate ?? '—'}</td>
      <td className="py-2 pr-3 text-sm">
        <div>{describeCycle(row.cycle)}</div>
        <div className="text-xs text-muted-foreground">
          {row.schedule?.configured
            ? `${row.schedule.description} · next ${formatIsoDate(row.schedule.nextOccurrence)}`
            : 'no recurring day set'}
        </div>
      </td>
      <td className="py-2 text-sm">
        {row.nextExpected?.name ? (
          <span className="font-medium">
            {row.nextExpected.name}
            {row.nextExpected.predictedNextDate && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {formatIsoDate(row.nextExpected.predictedNextDate)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}


function TrackingConfigCard() {
  const toast = useToast();
  const { tracking, saveTracking, isLoading } = useTracking();

  const [namesDraft, setNamesDraft] = useState<string | null>(null);
  const [patternsDraft, setPatternsDraft] = useState<string | null>(null);
  const [matchContacts, setMatchContacts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (tracking && !initialized) {
    setInitialized(true);
    setNamesDraft((tracking.variableNames ?? []).join('\n'));
    setPatternsDraft((tracking.patterns ?? []).join('\n'));
    setMatchContacts(tracking.matchContacts !== false);
  }

  const save = async () => {
    setSaving(true);
    try {
      await saveTracking({
        variableNames: (namesDraft ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        patterns: (patternsDraft ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        matchContacts,
      });
      toast.success('Tracking configuration saved — future snapshots follow the new rules.', {
        title: 'Tracking saved',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save tracking config.', {
        title: 'Save failed',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Tracked variables</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading configuration…</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="tracking-names">Variable names (one per line)</Label>
            <textarea
              id="tracking-names"
              className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={namesDraft ?? ''}
              onChange={(e) => setNamesDraft(e.target.value)}
              placeholder={'Preacher\nSong Leader'}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tracking-patterns">Or name patterns (one per line)</Label>
            <textarea
              id="tracking-patterns"
              className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={patternsDraft ?? ''}
              onChange={(e) => setPatternsDraft(e.target.value)}
              placeholder={'assign_\nschedule_'}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchContacts}
              onChange={(e) => setMatchContacts(e.target.checked)}
              className="h-4 w-4"
            />
            Try to link names to contacts (for phone lookup)
          </label>
          <Button onClick={save} disabled={saving || isLoading}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save tracking
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function RotationPanel() {
  const { variables: trackedVariables, isLoading: namesLoading } = useRotationVariables();
  const trackedNames = useMemo(
    () => trackedVariables.map((v) => (typeof v === 'string' ? v : v.name)),
    [trackedVariables]
  );
  const [selected, setSelected] = useState('');
  const { report, overview, isLoading, error, refetch } = useRotation(selected || undefined);

  const people = report?.people ?? [];
  const overviewRows = useMemo(() => (Array.isArray(overview) ? overview : []), [overview]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Rotation Analysis</h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Repeat className="h-3.5 w-3.5" />
            {trackedNames.length} tracked variable{trackedNames.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* ---- what gets tracked ---- */}
      <TrackingConfigCard />

      {/* ---- when it happens ---- */}
      <ScheduleRulesCard />

      {/* ---- overview of every tracked variable ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            All tracked variables
          </CardTitle>
        </CardHeader>
        <CardContent>
          {namesLoading || (isLoading && !selected) ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Analysing the ledger…
            </p>
          ) : overviewRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tracked variables have ledger entries yet. Once the bridge syncs changes, cycles appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Variable</th>
                    <th className="py-2 pr-3 font-medium">Entries</th>
                    <th className="py-2 pr-3 font-medium">People</th>
                    <th className="py-2 pr-3 font-medium">Last</th>
                    <th className="py-2 pr-3 font-medium">Cycle / schedule</th>
                    <th className="py-2 font-medium">Next expected</th>
                  </tr>
                </thead>
                <tbody>
                  {overviewRows.map((row) => (
                    <OverviewRow key={row.variableName} row={row} onOpen={(name) => setSelected(name)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {/* ---- per-variable detail ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Variable detail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="rotation-variable">Variable</Label>
              <select
                id="rotation-variable"
                className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">All / none selected</option>
                {trackedNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {selected && !trackedNames.includes(selected) && (
                  <option value={selected}>{selected}</option>
                )}
              </select>
            </div>
            {selected && (
              <Button variant="ghost" size="sm" onClick={() => setSelected('')}>
                Clear
              </Button>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error instanceof Error ? error.message : 'Could not load the rotation report.'}</span>
            </div>
          )}

          {selected && report && !report.hasData && (
            <p className="text-sm text-muted-foreground">No ledger entries for “{selected}” yet.</p>
          )}

          {selected && report && report.hasData && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm font-medium">{describeCycle(report.cycle)}</span>
                {report.dominantWeekday && (
                  <span className="text-sm text-muted-foreground">
                    · usually {report.dominantWeekday.weekday} ({Math.round(report.dominantWeekday.share * 100)}%)
                  </span>
                )}
                {report.entryWeekday && (
                  <span className="text-sm text-muted-foreground">
                    · entered on {report.entryWeekday.weekday}s
                  </span>
                )}
                <span className="text-sm text-muted-foreground">
                  · {report.totalAssignments} service{report.totalAssignments === 1 ? '' : 's'}
                  {report.recordedAssignments != null && report.recordedAssignments !== report.totalAssignments
                    ? ` from ${report.recordedAssignments} recorded entr${report.recordedAssignments === 1 ? 'y' : 'ies'}`
                    : ''}
                </span>
              </div>
              <CycleChips cycle={report.cycle} />

              {report.schedule?.configured ? (
                <div className="space-y-1 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Repeat className="h-3.5 w-3.5" />
                      {report.schedule.description}
                    </span>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      next {formatIsoDate(report.schedule.nextOccurrence)}
                    </span>
                    {report.schedule.leadDays != null && (
                      <span className="text-xs text-muted-foreground">
                        entered{' '}
                        {report.schedule.leadDays === 0
                          ? 'on the service day'
                          : `${report.schedule.leadDays} day${report.schedule.leadDays === 1 ? '' : 's'} before`}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Following:{' '}
                    {report.schedule.upcoming.slice(1).map((day) => formatIsoDate(day)).join(' · ') || '—'}
                    {report.entryWeekday ? ` · entries recorded on ${report.entryWeekday.weekday}` : ''}
                  </p>
                  {report.schedule.recentMappings && report.schedule.recentMappings.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Recorded → service:{' '}
                      {report.schedule.recentMappings
                        .map((mapping) => `${mapping.recorded} → ${mapping.serviceDate}`)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    No recurring day is set for this variable, so the dates above are the days the
                    schedule was <em>recorded</em> and &ldquo;next&rdquo; cannot land on a specific
                    service yet. Set it under <span className="font-medium">Recurring schedules</span>{' '}
                    above.
                  </span>
                </div>
              )}

              {report.nextExpected?.name && (
                <div className="rounded-lg bg-muted/40 p-3 text-sm">
                  <span className="font-medium">Next expected:</span> {report.nextExpected.name}
                  {report.nextExpected.predictedNextDate && (
                    <span className="text-muted-foreground">
                      {' '}
                      on {formatIsoDate(report.nextExpected.predictedNextDate)}
                    </span>
                  )}
                  {report.nextExpected.basis && (
                    <span className="text-muted-foreground"> ({report.nextExpected.basis.replace(/-/g, ' ')})</span>
                  )}
                  {report.nextExpected.confidence != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {Math.round(report.nextExpected.confidence * 100)}% consistent
                    </span>
                  )}
                </div>
              )}

              {report.rotationOrder.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Rotation order
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {report.rotationOrder.map((name, index) => (
                      <span key={`${name}-${index}`} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                        {index + 1}. {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Person</th>
                      <th className="py-2 pr-3 font-medium">Turns</th>
                      <th className="py-2 pr-3 font-medium">First</th>
                      <th className="py-2 pr-3 font-medium">Last</th>
                      <th className="py-2 pr-3 font-medium">Gap</th>
                      <th className="py-2 pr-3 font-medium">Days since</th>
                      <th className="py-2 font-medium">Next (predicted)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((person) => (
                      <tr key={person.name} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium">{person.name}</td>
                        <td className="py-2 pr-3">{person.turnCount}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{person.firstAssigned}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{person.lastAssigned}</td>
                        <td className="py-2 pr-3">{person.gapDays != null ? `${person.gapDays}d` : '—'}</td>
                        <td className="py-2 pr-3">{person.daysSinceLast ?? '—'}</td>
                        <td className="py-2">{person.predictedNextDate ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!selected && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              Pick a variable above (or click one in the overview) for the full recurrence report.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
