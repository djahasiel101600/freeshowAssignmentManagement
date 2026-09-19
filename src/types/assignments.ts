/**
 * Types for the assignment ledger and the rotation analysis.
 *
 * These mirror the camelCase payloads produced by the receiver's
 * ``Assignment.to_dict()`` / ``AssignmentChange.to_dict()``.
 */

export type AssignmentSource = 'bridge' | 'snapshot' | 'manual' | 'api' | 'imported';

export interface AssignmentRecord {
  id: string;
  /** Calendar day (YYYY-MM-DD) in the configured schedule timezone. */
  date: string;
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

export interface RotationReport {
  variableName: string;
  hasData: boolean;
  totalAssignments: number;
  distinctPeople: number;
  firstDate: string | null;
  lastDate: string | null;
  lookbackDays: number;
  people: RotationPerson[];
  rotationOrder: string[];
  cycle: CycleInfo;
  dominantWeekday: { weekday: string; share: number } | null;
  nextExpected: { name?: string; basis?: string; predictedNextDate?: string } | null;
}

export interface RotationOverviewRow {
  variableName: string;
  hasData: boolean;
  totalAssignments: number;
  distinctPeople: number;
  lastDate: string | null;
  cycle: CycleInfo;
  nextExpected: RotationReport['nextExpected'];
  rotationOrder: string[];
  dominantWeekday: RotationReport['dominantWeekday'];
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