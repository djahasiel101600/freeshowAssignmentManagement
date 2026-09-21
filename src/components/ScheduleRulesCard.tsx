import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import {
  useBackfillSchedules,
  useDeleteSchedule,
  useRotationVariables,
  useSaveSchedule,
  useSchedules,
} from '../hooks/useScheduleData';
import type { ScheduleBackfillResult, ScheduleInfo } from '../types/assignments';
import {
  AlertCircle, CalendarClock, CheckCircle2, History, Loader2, Repeat, Save, Trash2,
} from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Recurring schedules.
 *
 * The bridge only reports *when* a variable changed on screen, so the ledger is
 * dated on the evening the next week's schedule is typed in - not on the Friday,
 * Saturday or Sunday service the assignment is for. Declaring the recurring
 * weekday here is what lets the rotation analysis answer "next Sunday, 27 Sep"
 * instead of "next time the schedule is typed in".
 */

const WEEKDAY_OPTIONS = [
  { value: 0, short: 'Mon', long: 'Monday' },
  { value: 1, short: 'Tue', long: 'Tuesday' },
  { value: 2, short: 'Wed', long: 'Wednesday' },
  { value: 3, short: 'Thu', long: 'Thursday' },
  { value: 4, short: 'Fri', long: 'Friday' },
  { value: 5, short: 'Sat', long: 'Saturday' },
  { value: 6, short: 'Sun', long: 'Sunday' },
];

const PRESETS = [
  { label: 'Every Friday', weekdays: [4] },
  { label: 'Every Saturday', weekdays: [5] },
  { label: 'Every Sunday', weekdays: [6] },
  { label: 'Fri + Sat + Sun', weekdays: [4, 5, 6] },
];

interface DraftState {
  weekdays: number[];
  intervalWeeks: number;
  anchorDate: string;
  leadDays: number;
  label: string;
  enabled: boolean;
}

function draftFrom(rule: ScheduleInfo | undefined): DraftState {
  return {
    weekdays: rule?.weekdays ?? [],
    intervalWeeks: rule?.intervalWeeks ?? 1,
    anchorDate: rule?.anchorDate ?? '',
    leadDays: rule?.leadDays ?? 1,
    label: rule?.label ?? '',
    enabled: rule?.enabled ?? true,
  };
}

/** "2026-09-27" -> "Sun, 27 Sep 2026". */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}


function ScheduleRuleRow({ variableName, rule }: { variableName: string; rule?: ScheduleInfo }) {
  const toast = useToast();
  const { saveSchedule, isSaving } = useSaveSchedule();
  const { deleteSchedule, isDeleting } = useDeleteSchedule();

  const [draft, setDraft] = useState<DraftState>(() => draftFrom(rule));
  const [touched, setTouched] = useState(false);

  /** Stable, HTML-safe ids for the per-row inputs. */
  const fieldId = (suffix: string) =>
    `schedule-${suffix}-${variableName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  // Re-sync whenever the server copy changes (after a save, or another device).
  useEffect(() => {
    setDraft(draftFrom(rule));
    setTouched(false);
  }, [rule?.updatedAt, rule?.configured, variableName]);

  const update = (patch: Partial<DraftState>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setTouched(true);
  };

  const toggleWeekday = (value: number) => {
    const next = draft.weekdays.includes(value)
      ? draft.weekdays.filter((day) => day !== value)
      : [...draft.weekdays, value].sort((a, b) => a - b);
    update({ weekdays: next });
  };

  const save = async () => {
    if (draft.weekdays.length === 0) {
      toast.error('Pick at least one weekday — that is the day the assignment is for.', {
        title: 'Weekday required',
      });
      return;
    }
    try {
      const { created } = await saveSchedule({
        variableName,
        rule: {
          weekdays: draft.weekdays,
          intervalWeeks: draft.intervalWeeks,
          anchorDate: draft.anchorDate || undefined,
          leadDays: draft.leadDays,
          label: draft.label,
          enabled: draft.enabled,
        },
      });
      toast.success(
        created
          ? `Recurring schedule saved — predictions for ${variableName} now use it.`
          : `Recurring schedule updated for ${variableName}.`,
        { title: 'Schedule saved' }
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the schedule.', {
        title: 'Save failed',
      });
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Remove the recurring schedule for ${variableName}? Predictions fall back to the recorded days.`
      )
    ) {
      return;
    }
    try {
      await deleteSchedule(variableName);
      toast.info('Recurring schedule removed.', { title: 'Removed' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the schedule.', {
        title: 'Delete failed',
      });
    }
  };

  const pattern = rule?.entryPattern;
  const needsAttention =
    rule?.configured === true && pattern?.matchesInterval === false && (pattern.sampleCount ?? 0) > 1;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{variableName}</span>
        {rule?.configured ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            <Repeat className="h-3 w-3" />
            {rule.description ?? 'schedule set'}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
            no schedule set
          </span>
        )}
        {rule?.rowCount != null && (
          <span className="text-xs text-muted-foreground">
            {rule.rowCount} ledger entr{rule.rowCount === 1 ? 'y' : 'ies'}
          </span>
        )}
        {touched && <span className="text-xs text-yellow-600">unsaved changes</span>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => {
          const active =
            preset.weekdays.length === draft.weekdays.length &&
            preset.weekdays.every((day) => draft.weekdays.includes(day));
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => update({ weekdays: [...preset.weekdays] })}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input hover:bg-muted'
              )}
            >
              {preset.label}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-border" />
        {WEEKDAY_OPTIONS.map((day) => {
          const active = draft.weekdays.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleWeekday(day.value)}
              title={day.long}
              className={cn(
                'h-7 w-9 rounded-md border text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-input text-muted-foreground hover:bg-muted'
              )}
            >
              {day.short}
            </button>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor={fieldId('interval')} className="text-xs">
            Repeat every (weeks)
          </Label>
          <Input
            id={fieldId('interval')}
            type="number"
            min={1}
            max={12}
            className="h-9"
            value={draft.intervalWeeks}
            onChange={(e) =>
              update({ intervalWeeks: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={fieldId('anchor')} className="text-xs">
            Anchor date
          </Label>
          <Input
            id={fieldId('anchor')}
            type="date"
            className="h-9"
            value={draft.anchorDate}
            onChange={(e) => update({ anchorDate: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={fieldId('lead')} className="text-xs">
            Schedule is entered (days before)
          </Label>
          <Input
            id={fieldId('lead')}
            type="number"
            min={0}
            max={14}
            className="h-9"
            value={draft.leadDays}
            onChange={(e) =>
              update({ leadDays: Math.max(0, Math.min(14, Number(e.target.value) || 0)) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={fieldId('label')} className="text-xs">
            Label (optional)
          </Label>
          <Input
            id={fieldId('label')}
            className="h-9"
            value={draft.label}
            placeholder="Sunday devotional"
            onChange={(e) => update({ label: e.target.value })}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Entries are expected{' '}
        {draft.leadDays === 0
          ? 'on the service day itself'
          : `${draft.leadDays} day${draft.leadDays === 1 ? '' : 's'} before the service`}
        {rule?.recentMappings && rule.recentMappings.length > 0 && (
          <>
            {' '}
            — saved rule maps{' '}
            {rule.recentMappings
              .map((mapping) => `${mapping.recorded} → ${mapping.serviceDate}`)
              .join(', ')}
          </>
        )}
      </p>

      {rule?.configured && (
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="rounded-lg bg-muted/40 p-2">
            <p className="text-xs text-muted-foreground">Next service</p>
            <p className="font-medium">{formatIsoDate(rule.nextOccurrence)}</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-2">
            <p className="text-xs text-muted-foreground">Following</p>
            <p className="font-medium">
              {rule.upcoming.slice(1, 4).map((day) => formatIsoDate(day)).join(' · ') || '—'}
            </p>
          </div>
          <div className="rounded-lg bg-muted/40 p-2">
            <p className="text-xs text-muted-foreground">Anchor</p>
            <p className="font-medium">{formatIsoDate(rule.anchorDate)}</p>
          </div>
        </div>
      )}

      {needsAttention && (
        <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-2 text-xs text-yellow-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Entries for this variable were recorded every {pattern?.modalGapDays} days on average,
            but {rule?.description} expects every {pattern?.expectedGapDays} days. Check the
            &ldquo;days before&rdquo; value, or whether a week was skipped.
          </span>
        </div>
      )}

      {pattern?.matchesInterval === true && (
        <p className="flex items-center gap-1.5 text-xs text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Entries arrive every {pattern.expectedGapDays} days, matching this schedule.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={isSaving || !touched}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {rule?.configured ? 'Save schedule' : 'Set schedule'}
        </Button>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={draft.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Use this schedule for predictions
        </label>
        {rule?.configured && (
          <Button size="sm" variant="ghost" onClick={remove} disabled={isDeleting}>
            {isDeleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4 text-destructive" />
            )}
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}


/** "Apply the rules to what is already recorded" panel. */
function BackfillPanel() {
  const toast = useToast();
  const { backfillSchedules, isApplying } = useBackfillSchedules();
  const [preview, setPreview] = useState<ScheduleBackfillResult | null>(null);

  const runPreview = async () => {
    try {
      const result = await backfillSchedules({ dryRun: true });
      setPreview(result);
      if (result.applied === 0) {
        toast.info('Every recorded entry already matches its schedule.', { title: 'Nothing to update' });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not check the history.', {
        title: 'Check failed',
      });
    }
  };

  const apply = async () => {
    try {
      const result = await backfillSchedules({});
      setPreview(null);
      toast.success(
        `Dated ${result.applied} ledger entr${result.applied === 1 ? 'y' : 'ies'} from the schedules.`,
        { title: 'History updated' }
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the history.', {
        title: 'Update failed',
      });
    }
  };

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Apply the schedules to past entries</span>
        <span className="text-xs text-muted-foreground">
          Keeps the ledger as-is but stores the service date each entry belongs to.
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={runPreview} disabled={isApplying}>
          {isApplying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Check history
        </Button>
      </div>

      {preview && preview.applied > 0 && (
        <div className="space-y-2 rounded-md border bg-background p-2 text-sm">
          <p className="font-medium">
            {preview.applied} entr{preview.applied === 1 ? 'y' : 'ies'} would be dated from the
            schedules{preview.truncated ? ' (showing the first few)' : ''}.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {preview.preview.slice(0, 5).map((item) => (
              <li key={`${item.variableName}-${item.recordedDate}`}>
                {item.variableName}: recorded {item.recordedDate} → for {item.scheduleDate}
                {item.person ? ` (${item.person})` : ''}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" onClick={apply} disabled={isApplying}>
              {isApplying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Update {preview.applied} entr{preview.applied === 1 ? 'y' : 'ies'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}


export function ScheduleRulesCard() {
  const { variables: trackedVariables, isLoading: namesLoading } = useRotationVariables();
  const { schedules, isLoading, error, refetch } = useSchedules();

  const trackedNames = trackedVariables.map((item) => (typeof item === 'string' ? item : item.name));
  const ruleByVariable = new Map(schedules.map((rule) => [rule.variableName ?? '', rule]));
  // Tracked variables first (the picker order), then any leftover rule, so a rule
  // is never hidden just because its variable stopped appearing in the ledger.
  const variableNames = [
    ...trackedNames,
    ...schedules
      .map((rule) => rule.variableName ?? '')
      .filter((name) => name && !trackedNames.includes(name)),
  ];

  const configured = schedules.filter((rule) => rule.configured).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarClock className="h-5 w-5" />
              Recurring schedules
            </CardTitle>
            <CardDescription>
              Tell the app which weekday each assignment is <em>for</em> (every Friday / Saturday /
              Sunday…). Entries recorded before the service are then counted on the service itself,
              so the rotation prediction lands on the right day.
              {schedules.length > 0 && (
                <>
                  {' '}
                  {configured} of {schedules.length} schedule{schedules.length === 1 ? '' : 's'} active.
                </>
              )}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Repeat className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error instanceof Error ? error.message : 'Could not load the schedules.'}</span>
          </div>
        )}

        {namesLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading tracked variables…
          </p>
        ) : variableNames.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tracked variables yet. Save the tracking rules above first — then each variable can be
            given a recurring day.
          </p>
        ) : (
          variableNames.map((name) => (
            <ScheduleRuleRow key={name} variableName={name} rule={ruleByVariable.get(name)} />
          ))
        )}

        {schedules.some((rule) => rule.configured) && <BackfillPanel />}
      </CardContent>
    </Card>
  );
}

