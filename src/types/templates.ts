/**
 * Server-side template + conditional-rule types.
 *
 * These are the shapes returned by the receiver (``Template.to_dict()`` and
 * ``ConditionalRule.to_dict()``). The composer used to define the same
 * interface locally next to its localStorage code; keeping it here lets the
 * hooks and the components share one definition.
 */

export interface VariableTitlePair {
  id: string;
  variableName: string;
  title: string;
  displayName?: string;
}

export interface SavedTemplate {
  id: string;
  name: string;
  content: string;
  variableTitlePairs: VariableTitlePair[];
  assignedContactIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type ConditionType = 'name-equals' | 'name-contains' | 'nickname-equals';

export interface ConditionalRule {
  id: string;
  variableName: string;
  condition: ConditionType;
  templateId: string;
  createdAt: string;
}

export const CONDITION_LABELS: Record<ConditionType, string> = {
  'name-equals': 'Name equals',
  'name-contains': 'Name contains',
  'nickname-equals': 'Nickname equals',
};