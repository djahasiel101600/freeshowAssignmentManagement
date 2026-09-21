/**
 * Types for the assignment ledger and the rotation analysis.
 *
 * These mirror the camelCase payloads produced by the receiver's
 * ``Assignment.to_dict()`` / ``AssignmentChange.to_dict()``.
 */

export type AssignmentSource = 'bridge' | 'snapshot' | 'manual' | 'api' | 'imported';

/** Where a row's service date comes from. */
export type ScheduleSource = 'pinned' | 'rule' | 'recorded';

export interface AssignmentRecord {
  id: string;
  /** Calendar day (YYYY-MM-DD) the bridge/operator *recorded* the change. */
  date: string;
  /** Service date stored on the row, when someone pinned it explicitly. */
  scheduleDate: string | null;
  /** Date the analysis counts the row on (pinned -> rule -> recorded). */
  effectiveDate?: string;
  scheduleSource?: ScheduleSource;
  scheduleDescription?: string | null;
  variableId: string;
  variableName: string;
  value: string;
  contactId: string | null;
  contactName: string;
  contactPhone: string;
  source: AssignmentSource | string;
  note: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface AssignmentChange {
  id: string;
  assignmentId: string | null;
  date: string;
  variableId: string;
  variableName: string;
  previousValue: string;
  newValue: string;
  previousContactName: string;
  newContactName: string;
  newContactId: string | null;
  source: string;
  trigger: string;
  note: string;
  changedAt: string;
}

export interface CycleInfo {
  periodDays: number | null;
  periodLabel: string | null;
  consistency: number | null;
  isRegular: boolean;
  sequenceRepeats: boolean;
  sequenceAccuracy: number | null;
  rotationLength: number;
  gapSampleCount?: number;
  gapMin?: number | null;
  gapMax?: number | null;
  gapMedian?: number | null;
  gapMean?: number | null;
  gapModalGap?: number | null;
  gapModeShare?: number | null;
  gapStdev?: number | null;
  gapConsistent?: boolean;
}

// --------------------------------------------------------------------------- //
// Recurring schedules
// --------------------------------------------------------------------------- //
/** What the operator declares for one variable. */
export interface ScheduleRuleInput {
  /** 0 = Monday ... 6 = Sunday. `[6]` is "every Sunday". */
  weekdays: number[];
  intervalWeeks: number;
  /** One real occurrence; pins the phase of an "every N weeks" rule. */
  anchorDate?: string;
  /** How many days before the service the schedule is entered. */
  leadDays: number;
  label?: string;
  enabled?: boolean;
  notes?: string;
}

/** How entries were actually recorded, compared with the declared interval. */
export interface ScheduleEntryPattern {
  sampleCount: number;
  modalGapDays: number | null;
  modeShare: number | null;
  expectedGapDays: number | null;
  matchesInterval: boolean | null;
}

/** One recorded date mapped onto the service it was entered for. */
export interface ScheduleMapping {
  recorded: string;
  serviceDate: string;
  person: string;
}

/**
 * A variable's recurring calendar, resolved by the server.
 *
 * `nextOccurrence`/`upcoming` are real service dates, which is what makes the
 * rotation prediction land on a Friday/Saturday/Sunday instead of on the day
 * the schedule happened to be typed in.
 */
export interface ScheduleInfo {
  configured: boolean;
  variableName: string | null;
  label: string;
  weekdays: number[];
  weekdayLabels: string[];
  intervalWeeks: number | null;
  anchorDate: string | null;
  leadDays: number | null;
  enabled: boolean;
  notes: string;
  /** e.g. "every Sunday". */
  description: string | null;
  nextOccurrence: string | null;
  previousOccurrence: string | null;
  /** The next few occurrence dates. */
  upcoming: string[];
  intervalDays?: number;
  lastServiceDate?: string | null;
  /** Ledger rows recorded for this variable (list endpoint only). */
  rowCount?: number;
  entryPattern?: ScheduleEntryPattern;
  recentMappings?: ScheduleMapping[];
  source: ScheduleSource;
  updatedAt?: string | null;
}

export interface ScheduleBackfillPreviewItem {
  variableName: string;
  recordedDate: string;
  scheduleDate: string;
  previousScheduleDate: string | null;
  person: string;
}

export interface ScheduleBackfillResult {
  ok: boolean;
  dryRun: boolean;
  variables: string[];
  applied: number;
  unchanged: number;
  skipped: number;
  preview: ScheduleBackfillPreviewItem[];
  truncated: boolean;
}

export interface RotationPerson {
  name: string;
  contactId: string | null;
  turnCount: number;
  firstAssigned: string;
  lastAssigned: string;
  daysSinceLast: number | null;
  /** Median days between this person's turns. */
  gapDays: number | null;
  modalGapDays: number | null;
  predictedNextDate: string | null;
  weekdays: string[];
  intervalSampleCount?: number;
  intervalMin?: number | null;
  intervalMax?: number | null;
  intervalMedian?: number | null;
  intervalMean?: number | null;
  intervalModalGap?: number | null;
  intervalModeShare?: number | null;
  intervalStdev?: number | null;
  intervalConsistent?: boolean;
}

export interface WeekdayStat {
  weekday: string;
  weekdayIndex?: number;
  share: number;
}

export interface NextExpected {
  name?: string;
  /** Why this person: rotation-order, fewest-turns, ... */
  basis?: string;
  /** The service date the person is expected on. */
  predictedNextDate?: string;
  /** Rule-based occurrence, when a schedule rule is configured. */
  scheduleDate?: string | null;
  /** The person's own cadence estimate (median gap between their turns). */
  personPredictedDate?: string | null;
  confidence?: number | null;
}

export interface RotationReport {
  variableName: string;
  hasData: boolean;
  totalAssignments: number;
  /** Ledger rows before the recorded -> service date mapping. */
  recordedAssignments?: number;
  distinctPeople: number;
  firstDate: string | null;
  lastDate: string | null;
  lookbackDays: number;
  people: RotationPerson[];
  rotationOrder: string[];
  cycle: CycleInfo;
  /** The recurring calendar this report is anchored on. */
  schedule: ScheduleInfo;
  /** Weekday the assignment is *for*. */
  dominantWeekday: WeekdayStat | null;
  /** Weekday the schedule is typed in (raw observations). */
  entryWeekday?: WeekdayStat | null;
  nextExpected: NextExpected | null;
}

export interface RotationOverviewRow {
  variableName: string;
  hasData: boolean;
  totalAssignments: number;
  distinctPeople: number;
  lastDate: string | null;
  cycle: CycleInfo;
  schedule?: ScheduleInfo;
  nextExpected: NextExpected | null;
  rotationOrder: string[];
  dominantWeekday: WeekdayStat | null;
  entryWeekday?: WeekdayStat | null;
}

export interface RotationPersonSummary {
  name: string;
  contactId: string | null;
  contactPhone: string;
  turnCount: number;
  firstDate: string;
  lastDate: string;
  variables: { name: string; count: number }[];
}

export interface AssignmentTrackingConfig {
  variableNames: string[];
  patterns: string[];
  matchContacts: boolean;
}

export interface BackupBundle {
  app: string;
  version: number;
  exportedAt: string;
  sections: Record<string, unknown[]>;
}