import { useCallback, useMemo, useState, useTransition } from 'react';
import { useFreeShowVariables } from '../hooks/useFreeShowVariables';
import { useContacts } from '../hooks/useContacts';
import { useMessageLogs } from '../hooks/useMessageLogs';
import { useConditionalRules, useMessageLayout, useTemplates } from '../hooks/useServerData';
import { semaphoreAPI } from '../lib/semaphore-api';
import { getCachedServerVariables } from '../lib/server-api';
import { buildMessageFromTemplate } from '../lib/message-utils';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { useToast } from './ui/toast';
import type { Contact } from '../types/contacts';
import {
  Plus, Trash2, RefreshCw, Send, ScanSearch, Info, AlertTriangle,
  ArrowRight, Workflow, Check, Square, CheckSquare, Eraser
} from 'lucide-react';

type ConditionType = 'name-equals' | 'name-contains' | 'nickname-equals';

interface ConditionalRule {
  id: string;
  variableName: string;
  condition: ConditionType;
  templateId: string;
  createdAt: string;
}

interface PreviewMatch {
  key: string;
  ruleId: string;
  variableName: string;
  variableValue: string;
  contact: Contact;
  templateName: string;
  message: string;
}

const CONDITION_LABELS: Record<ConditionType, string> = {
  'name-equals': 'Name equals',
  'name-contains': 'Name contains',
  'nickname-equals': 'Nickname equals',
};

const normalize = (value: string): string => value.trim().toLowerCase();


export function ConditionalSender() {
  const { variables, refetch } = useFreeShowVariables();
  const { contacts } = useContacts();
  const { addLogs } = useMessageLogs();
  const toast = useToast();

  // Templates + rules come from the receiver's database now (react-query).
  const { templates, refetch: refetchTemplates } = useTemplates();
  // Same global header/footer the composer uses (shared server setting).
  const { layout: globalLayout } = useMessageLayout();
  const {
    rules,
    create: createRuleApi,
    update: updateRuleApi,
    remove: removeRuleApi,
    refetch: refetchRules,
  } = useConditionalRules();

  const [preview, setPreview] = useState<PreviewMatch[] | null>(null);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [dedupeContacts, setDedupeContacts] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [previewWarning, setPreviewWarning] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ duplicates: number } | null>(null);
  
  const [isPreviewing, startPreviewTransition] = useTransition();

  const refreshData = useCallback(() => {
    void refetchTemplates();
    void refetchRules();
    toast.info('Templates and rules refreshed from the server.', { title: 'Data Updated' });
  }, [toast, refetchTemplates, refetchRules]);

  const allVariables = useMemo(() => {
    const merged = new Map<string, { name: string; value: string }>();
    for (const v of variables) merged.set(v.id, v);
    for (const v of getCachedServerVariables()) {
      if (!merged.has(v.id)) merged.set(v.id, v);
    }
    return Array.from(merged.values());
  }, [variables]);

  const variableEntries = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of allVariables) {
      if (v.name && !map.has(v.name)) map.set(v.name, v.value ?? '');
    }
    return Array.from(map, ([name, value]) => ({ name, value })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [allVariables]);

  const ruleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const match of preview ?? []) {
      counts[match.ruleId] = (counts[match.ruleId] ?? 0) + 1;
    }
    return counts;
  }, [preview]);

  const includedMatches = useMemo(
    () => (preview ?? []).filter((m) => !excludedKeys.has(m.key)),
    [preview, excludedKeys]
  );

  const addRule = useCallback(() => {
    void createRuleApi({
      variableName: variableEntries[0]?.name ?? '',
      condition: 'name-equals',
      templateId: templates[0]?.id ?? '',
    }).catch(() => {
      toast.error('Could not add the rule. Is the server reachable?', { title: 'Server error' });
    });
    setPreview(null);
  }, [variableEntries, templates, createRuleApi, toast]);

  const updateRule = useCallback((id: string, patch: Partial<ConditionalRule>) => {
    void updateRuleApi(id, patch).catch(() => undefined);
    setPreview(null);
  }, [updateRuleApi]);

  const removeRule = useCallback((id: string) => {
    void removeRuleApi(id).catch(() => undefined);
    setPreview(null);
  }, [removeRuleApi]);

  const clearPreview = useCallback(() => {
    setPreview(null);
    setExcludedKeys(new Set());
    setPreviewMeta(null);
    setPreviewWarning(null);
  }, []);

  const runPreview = useCallback(() => {
    setPreviewWarning(null);
    setPreviewMeta(null);

    if (rules.length === 0) {
      setPreview(null);
      toast.info('Add at least one rule before previewing.', { title: 'No rules yet' });
      return;
    }
    if (templates.length === 0) {
      setPreview(null);
      toast.error('Save a message template in the Messages tab first.', { title: 'No templates' });
      return;
    }
    if (contacts.length === 0) {
      setPreview(null);
      toast.error('Add contacts first so members can be matched by name.', { title: 'No contacts' });
      return;
    }
    if (variableEntries.length === 0) {
      setPreview(null);
      toast.error('No FreeShow variables found. Make sure FreeShow is running and variables exist.', {
        title: 'No variables',
      });
      return;
    }

    startPreviewTransition(() => {
      const matches: PreviewMatch[] = [];
      const seenContacts = new Set<string>();
      let duplicates = 0;
      let missingTemplates = 0;

      for (const rule of rules) {
        const template = templates.find((t) => t.id === rule.templateId);
        if (!template || !(template.content || '').trim()) {
          missingTemplates++;
          continue;
        }

        const ruleVariables = allVariables.filter(
          (v) => v.name === rule.variableName && (v.value ?? '').trim() !== ''
        );

        for (const variable of ruleVariables) {
          const value = (variable.value ?? '').trim();

          const matchedContacts = contacts.filter((contact) => {
            switch (rule.condition) {
              case 'name-equals':
                return normalize(contact.name) === normalize(value);
              case 'name-contains':
                return normalize(contact.name).includes(normalize(value));
              case 'nickname-equals':
                return (contact.nicknames ?? []).some((n) => normalize(n) === normalize(value));
            }
          });

          for (const contact of matchedContacts) {
            if (dedupeContacts) {
              if (seenContacts.has(contact.id)) {
                duplicates++;
                continue;
              }
              seenContacts.add(contact.id);
            }

            let message: string;
            try {
              message = buildMessageFromTemplate({
                content: template.content,
                variables: allVariables,
                variableTitlePairs: template.variableTitlePairs,
                overrides: { [rule.variableName]: value },
                layout: globalLayout,
              });
            } catch (err) {
              console.error('Failed to build message for contact', contact.id, err);
              message = `[Error building message: ${err instanceof Error ? err.message : 'Unknown error'}]`;
            }
            
            if (!message.trim()) continue;

            matches.push({
              key: `${rule.id}::${rule.variableName}::${contact.id}`,
              ruleId: rule.id,
              variableName: rule.variableName,
              variableValue: value,
              contact,
              templateName: template.name,
              message,
            });
          }
        }
      }

      setPreview(matches);
      setExcludedKeys(new Set());
      setPreviewMeta({ duplicates });
      if (missingTemplates > 0) {
        setPreviewWarning(`${missingTemplates} rule(s) referenced a missing or empty template and were skipped.`);
      }
    });
  }, [rules, templates, contacts, variableEntries, allVariables, dedupeContacts, globalLayout, toast, startPreviewTransition]);

  const handleSend = useCallback(async () => {
    if (includedMatches.length === 0) {
      toast.error('No messages are ready to send. Run a preview first.', { title: 'Nothing to send' });
      return;
    }
    const config = semaphoreAPI.getConfig();
    if (!config.apiKey) {
      toast.error('Add your Semaphore API key in Settings before sending SMS.', { title: 'API key missing' });
      return;
    }

    setIsSending(true);
    try {
      const messages = includedMatches.map((m) => ({
        contactId: m.contact.id,
        contactName: m.contact.name,
        phoneNumber: m.contact.phoneNumber,
        message: m.message,
      }));

      const results = await semaphoreAPI.sendBulkMessages(
        messages.map(({ phoneNumber, message }) => ({ phoneNumber, message }))
      );

      const variablesMap = allVariables.reduce<Record<string, string>>((acc, v) => {
        acc[v.name] = v.value ?? '';
        return acc;
      }, {});

      const logs = results.map((result, index) => ({
        contactId: messages[index].contactId,
        contactName: messages[index].contactName,
        phoneNumber: messages[index].phoneNumber,
        message: messages[index].message,
        status: result.status === 'success' ? ('sent' as const) : ('failed' as const),
        sentAt: new Date().toISOString(),
        variables: variablesMap,
      }));

      addLogs(logs);

      const successCount = results.filter((r) => r.status === 'success').length;
      if (successCount === results.length) {
        toast.success(`Sent ${successCount} conditional message(s) to your members.`, {
          title: 'All messages sent',
        });
        clearPreview();
      } else if (successCount > 0) {
        toast.info(
          `Sent ${successCount} of ${results.length}. ${results.length - successCount} failed.`,
          { title: 'Partially sent' }
        );
      } else {
        const reasons = Array.from(
          new Set(
            results
              .map((r) => (r.status === 'error' ? `${r.message}${r.code ? ` (code: ${r.code})` : ''}` : ''))
              .filter(Boolean)
          )
        );
        toast.error(
          reasons.length > 0
            ? `None of the messages could be sent. ${reasons.join(' · ')}`
            : 'None of the messages could be sent. Check your Semaphore configuration.',
          { title: 'Send failed', duration: 10000 }
        );
      }
    } catch (error) {
      console.error('Send error:', error);
      toast.error('Something went wrong while sending. Please check your Semaphore configuration.', {
        title: 'Send failed',
      });
    } finally {
      setIsSending(false);
    }
  }, [includedMatches, allVariables, addLogs, toast, clearPreview]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Conditional Messages</h2>
          <p className="text-sm text-muted-foreground">
            Send saved templates automatically to everyone assigned in your FreeShow variables — 
            different messages for each role, all in one click.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refreshData}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Data
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isPreviewing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isPreviewing ? 'animate-spin' : ''}`} />
            Refresh Variables
          </Button>
        </div>
      </div>

      <Card className="bg-muted/40">
        <CardContent className="flex items-start gap-3 py-4 text-sm">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="text-muted-foreground leading-relaxed">
            Example: when <b>Devotional</b> = <b>John Doe</b>, John automatically receives the Devotional
            template; when <b>Usher</b> = <b>Jane Smith</b>, Jane receives the Usher template.
          </p>
        </CardContent>
      </Card>

      {(templates.length === 0 || contacts.length === 0 || variableEntries.length === 0) && (
        <Card className="border-amber-300/50 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-400/10">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1.5 text-sm text-amber-800 dark:text-amber-200">
              {templates.length === 0 && <p>• No message templates — save one in the <b>Messages</b> tab first.</p>}
              {contacts.length === 0 && <p>• No contacts — add members in the <b>Contacts</b> tab so names can be matched.</p>}
              {variableEntries.length === 0 && <p>• No FreeShow variables found — start FreeShow (or it may still be loading).</p>}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Rules</h3>
        <Button size="sm" onClick={addRule} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center text-center">
            <div className="mb-4 rounded-full bg-muted p-4">
              <Workflow className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">No conditional rules yet</h3>
            <p className="mx-auto mb-6 max-w-md text-sm text-muted-foreground">
              Create a rule that links a FreeShow variable (like "Devotional") to a saved message
              template. Everyone whose contact name matches the variable value will get that message.
            </p>
            <Button onClick={addRule} className="gap-2">
              <Plus className="h-4 w-4" />
              Create your first rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule, index) => {
            const currentValue = variableEntries.find((v) => v.name === rule.variableName)?.value ?? '';
            const count = ruleCounts[rule.id];
            return (
              <Card key={rule.id} className="transition-all hover:shadow-md">
                <CardContent className="space-y-4 pt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Workflow className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold">Rule {index + 1}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label="Delete rule"
                      onClick={() => removeRule(rule.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  <div className="grid gap-4 md:grid-cols-[1.2fr_1fr_1.5fr]">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">FreeShow Variable</Label>
                      {variableEntries.length > 0 ? (
                        <select
                          value={rule.variableName}
                          onChange={(e) => updateRule(rule.id, { variableName: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">Select a variable...</option>
                          {rule.variableName && !variableEntries.some((v) => v.name === rule.variableName) && (
                            <option value={rule.variableName}>{rule.variableName} (saved)</option>
                          )}
                          {variableEntries.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name} {v.value ? `(${v.value})` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          value={rule.variableName}
                          onChange={(e) => updateRule(rule.id, { variableName: e.target.value })}
                          placeholder="e.g., Devotional"
                          className="h-9"
                        />
                      )}
                      {currentValue && (
                        <p className="text-xs text-muted-foreground">
                          Current value: <span className="font-medium text-foreground">"{currentValue}"</span>
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Condition</Label>
                      <select
                        value={rule.condition}
                        onChange={(e) => updateRule(rule.id, { condition: e.target.value as ConditionType })}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {(Object.keys(CONDITION_LABELS) as ConditionType[]).map((key) => (
                          <option key={key} value={key}>
                            {CONDITION_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Message Template</Label>
                      <select
                        value={rule.templateId}
                        onChange={(e) => updateRule(rule.id, { templateId: e.target.value })}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="">Select a template...</option>
                        {rule.templateId && !templates.some((t) => t.id === rule.templateId) && (
                          <option value={rule.templateId} className="text-destructive">
                            ⚠️ Template missing
                          </option>
                        )}
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {preview !== null && (
                    <div className="flex items-center gap-2 pt-2 border-t">
                      {count ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                          <Check className="h-3.5 w-3.5" /> {count} member{count === 1 ? '' : 's'} matched
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                          No matches for this rule
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <Button 
          variant="default" 
          onClick={runPreview} 
          disabled={isPreviewing || rules.length === 0}
          className="gap-2"
        >
          <ScanSearch className={`h-4 w-4 ${isPreviewing ? 'animate-spin' : ''}`} />
          {isPreviewing ? 'Matching members…' : 'Preview Matches'}
        </Button>
        
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
          <Switch
            checked={dedupeContacts}
            onCheckedChange={(checked) => setDedupeContacts(Boolean(checked))}
            id="dedupe-contacts"
          />
          <Label htmlFor="dedupe-contacts" className="cursor-pointer text-sm font-medium">
            One message per person
          </Label>
        </div>

        <div className="flex-1" />
        
        <Button
          variant="outline"
          onClick={clearPreview}
          disabled={preview === null}
          className="gap-2"
        >
          <Eraser className="h-4 w-4" />
          Clear Preview
        </Button>

        <Button
          onClick={handleSend}
          disabled={includedMatches.length === 0 || isSending}
          className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Send className={`h-4 w-4 ${isSending ? 'animate-pulse' : ''}`} />
          {isSending
            ? 'Sending…'
            : `Send ${includedMatches.length} Message${includedMatches.length === 1 ? '' : 's'}`}
        </Button>
      </div>

      {previewWarning && (
        <Card className="border-amber-300/50 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-400/10">
          <CardContent className="flex items-start gap-3 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-800 dark:text-amber-200">{previewWarning}</p>
          </CardContent>
        </Card>
      )}

      {previewMeta && previewMeta.duplicates > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4" />
          {previewMeta.duplicates} duplicate(s) skipped by "one message per person".
        </p>
      )}

      {preview !== null && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">
              {includedMatches.length} message{includedMatches.length === 1 ? '' : 's'} ready
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                for {new Set(includedMatches.map((m) => m.contact.id)).size} recipient(s)
              </span>
            </h3>
            {preview.length > 0 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExcludedKeys(new Set())}
                  disabled={excludedKeys.size === 0}
                  className="gap-1.5"
                >
                  <CheckSquare className="h-4 w-4" />
                  Select All
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExcludedKeys(new Set(preview.map((m) => m.key)))}
                  disabled={excludedKeys.size === preview.length}
                  className="gap-1.5"
                >
                  <Square className="h-4 w-4" />
                  Deselect All
                </Button>
              </div>
            )}
          </div>

          {preview.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-8 text-center text-sm text-muted-foreground">
                <ScanSearch className="mb-2 h-8 w-8 opacity-50" />
                <p>No one matched your rules with the current variables and contacts.</p>
                <p>Check that a contact&apos;s name exactly matches the variable value, then preview again.</p>
              </CardContent>
            </Card>
          )}

          {includedMatches.map((m) => (
            <Card key={m.key} className="transition-all hover:shadow-sm">
              <CardContent className="space-y-3 pt-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={!excludedKeys.has(m.key)}
                    onChange={() => {
                      setExcludedKeys((prev) => {
                        const next = new Set(prev);
                        if (next.has(m.key)) next.delete(m.key);
                        else next.add(m.key);
                        return next;
                      });
                    }}
                    className="mt-1.5 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    aria-label="Include or exclude this message"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                        {m.variableName}
                      </span>
                      <span className="text-sm font-semibold">&quot;{m.variableValue}&quot;</span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{m.contact.name}</span>
                      <span className="text-xs text-muted-foreground">{m.contact.phoneNumber}</span>
                    </div>
                    <p className="text-xs font-medium text-muted-foreground">
                      Template: {m.templateName}
                    </p>
                  </div>
                </div>
                <div className="ml-7 rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground border">
                  {m.message}
                </div>
              </CardContent>
            </Card>
          ))}

          {preview.length > 0 && includedMatches.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-8 text-center text-sm text-muted-foreground">
                <p>All matched messages have been excluded.</p>
                <p>Tick a message back on to include it in the send batch.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}