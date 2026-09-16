import React, { useEffect, useMemo, useState } from 'react';
import { useFreeShowVariables } from '../hooks/useFreeShowVariables';
import { useContacts } from '../hooks/useContacts';
import { useMessageLogs } from '../hooks/useMessageLogs';
import { semaphoreAPI } from '../lib/semaphore-api';
import {
  buildMessageFromTemplate,
  loadGlobalLayout,
  saveGlobalLayout,
  type MessageLayout,
} from '../lib/message-utils';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import {
  Send, AlertCircle, CheckCircle2, Plus, X, GripVertical,
  ArrowUp, ArrowDown, Save, FolderOpen, Trash2, Copy,
  FileText, Edit2, Check, Users, UserPlus, ChevronDown,
  ChevronRight, Heading1, Quote, Search, Sparkles, Tag,
  MessageSquare, Loader2, Eraser,
} from 'lucide-react';

interface VariableTitlePair {
  id: string;
  variableName: string;
  title: string;
  displayName: string;
}

interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  variableTitlePairs: VariableTitlePair[];
  assignedContactIds: string[]; // Array of contact IDs
  createdAt: string;
  updatedAt: string;
}

// Rough SMS segment estimate: 160 chars for a single GSM-7 segment,
// 153 per segment once a message spans multiple segments.
function estimateSmsSegments(length: number) {
  if (length === 0) return 0;
  if (length <= 160) return 1;
  return Math.ceil(length / 153);
}

export function MessageComposer() {
  const { variables } = useFreeShowVariables();
  const { contacts } = useContacts();
  const { addLogs } = useMessageLogs();
  const toast = useToast();

  // Template management state
  const [templates, setTemplates] = useState<MessageTemplate[]>(() => {
    const saved = localStorage.getItem("messageTemplates");
    return saved ? JSON.parse(saved) : [];
  });
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(() => {
    return localStorage.getItem("currentTemplateId") || null;
  });
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false);
  const [editingTemplateName, setEditingTemplateName] = useState('');
  const [isRenaming, setIsRenaming] = useState<string | null>(null);
  const [isAssigningContacts, setIsAssigningContacts] = useState<string | null>(null);
  const [templateSearchTerm, setTemplateSearchTerm] = useState('');

  // Current template state
  const [messageTemplate, setMessageTemplate] = useState(() => {
    const saved = localStorage.getItem("messageTemplate");
    return saved || "";
  });
  const [variableTitlePairs, setVariableTitlePairs] = useState<VariableTitlePair[]>(() => {
    const saved = localStorage.getItem("variableTitlePairs");
    return saved ? JSON.parse(saved) : [];
  });

  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [contactSearchTerm, setContactSearchTerm] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [editingPair, setEditingPair] = useState<Partial<VariableTitlePair>>({});
  const [editingPairId, setEditingPairId] = useState<string | null>(null);
  const [isAddingPair, setIsAddingPair] = useState(false);
  const [insertTab, setInsertTab] = useState<'variables' | 'pairs'>('variables');

  // Global header/footer applied to every message built from a template
  const [globalLayout, setGlobalLayout] = useState<MessageLayout>(loadGlobalLayout);
  const [isLayoutOpen, setIsLayoutOpen] = useState(false);

  // Save pairs and template to localStorage
  useEffect(() => {
    localStorage.setItem("variableTitlePairs", JSON.stringify(variableTitlePairs));
  }, [variableTitlePairs]);

  useEffect(() => {
    saveGlobalLayout(globalLayout);
  }, [globalLayout]);

  useEffect(() => {
    localStorage.setItem("messageTemplate", messageTemplate);
  }, [messageTemplate]);

  // Save templates to localStorage
  useEffect(() => {
    localStorage.setItem("messageTemplates", JSON.stringify(templates));
  }, [templates]);

  useEffect(() => {
    if (currentTemplateId) {
      localStorage.setItem("currentTemplateId", currentTemplateId);
    }
  }, [currentTemplateId]);

  // Load template when switching
  useEffect(() => {
    if (currentTemplateId) {
      const template = templates.find(t => t.id === currentTemplateId);
      if (template) {
        setMessageTemplate(template.content);
        setVariableTitlePairs(template.variableTitlePairs);
        // Auto-select assigned contacts for this template
        setSelectedContacts(template.assignedContactIds || []);
      }
    }
  }, [currentTemplateId, templates]);

  const insertVariable = (variableName: string) => {
    setMessageTemplate(prev => prev + `{{${variableName}}}`);
  };

  const insertTitlePair = (pairId: string) => {
    setMessageTemplate(prev => prev + `{{TITLE_PAIR_${pairId}}}`);
  };

  const activeTemplate = useMemo(
    () => templates.find(t => t.id === currentTemplateId) || null,
    [templates, currentTemplateId]
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!activeTemplate) return messageTemplate.trim().length > 0 || variableTitlePairs.length > 0;
    return (
      activeTemplate.content !== messageTemplate ||
      JSON.stringify(activeTemplate.variableTitlePairs) !== JSON.stringify(variableTitlePairs) ||
      JSON.stringify(activeTemplate.assignedContactIds || []) !== JSON.stringify(selectedContacts)
    );
  }, [activeTemplate, messageTemplate, variableTitlePairs, selectedContacts]);

  // Template management functions
  const saveCurrentTemplate = () => {
    const templateName = prompt('Enter template name:', `Template ${templates.length + 1}`);
    if (!templateName) return;

    const newTemplate: MessageTemplate = {
      id: Date.now().toString(),
      name: templateName,
      content: messageTemplate,
      variableTitlePairs: variableTitlePairs,
      assignedContactIds: selectedContacts, // Save current selected contacts
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setTemplates([...templates, newTemplate]);
    setCurrentTemplateId(newTemplate.id);
    setStatus('success');
    setStatusMessage(`Template "${templateName}" saved with ${selectedContacts.length} assigned contact(s)!`);
    toast.info(`"${templateName}" saved with ${selectedContacts.length} contacts`, {
      title: 'Template saved',
    });
  };

  // Save the current editor contents back into the actively-loaded template,
  // letting the user edit an existing template's message content in place.
  const updateCurrentTemplate = () => {
    if (!currentTemplateId) return;
    const activeTemplate = templates.find((t) => t.id === currentTemplateId);
    if (!activeTemplate) return;

    const updatedTemplates = templates.map((t) =>
      t.id === currentTemplateId
        ? {
            ...t,
            content: messageTemplate,
            variableTitlePairs,
            assignedContactIds: selectedContacts,
            updatedAt: new Date().toISOString(),
          }
        : t
    );
    setTemplates(updatedTemplates);
    setStatus('success');
    setStatusMessage(`Updated template "${activeTemplate.name}"`);
    toast.success(`"${activeTemplate.name}" saved with your changes.`, { title: 'Template updated' });
  };

  const updateTemplateContacts = (templateId: string, contactIds: string[]) => {
    setTemplates(templates.map(t =>
      t.id === templateId
        ? { ...t, assignedContactIds: contactIds, updatedAt: new Date().toISOString() }
        : t
    ));
    // Update current selection if this is the active template
    if (currentTemplateId === templateId) {
      setSelectedContacts(contactIds);
    }
    setIsAssigningContacts(null);
    setStatus('success');
    setStatusMessage(`Updated assigned contacts for template`);
    setTimeout(() => setStatus('idle'), 3000);
  };

  const loadTemplate = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    if (template) {
      // Save current state before switching
      if (currentTemplateId) {
        const updatedTemplates = templates.map(t =>
          t.id === currentTemplateId
            ? { ...t,
                content: messageTemplate,
                variableTitlePairs: variableTitlePairs,
                assignedContactIds: selectedContacts,
                updatedAt: new Date().toISOString()
              }
            : t
        );
        setTemplates(updatedTemplates);
      }

      setCurrentTemplateId(templateId);
      setIsTemplateManagerOpen(false);
      // Load the template's assigned contacts
      setSelectedContacts(template.assignedContactIds || []);
      setStatus('success');
      setStatusMessage(`Loaded template: "${template.name}" with ${template.assignedContactIds?.length || 0} assigned contact(s)`);
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  const deleteTemplate = (templateId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this template?')) {
      const newTemplates = templates.filter(t => t.id !== templateId);
      setTemplates(newTemplates);
      if (currentTemplateId === templateId) {
        setCurrentTemplateId(null);
        setMessageTemplate('');
        setVariableTitlePairs([]);
        setSelectedContacts([]);
      }
      toast.info('Template deleted', { title: 'Template removed' });
    }
  };

  const duplicateTemplate = (templateId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const template = templates.find(t => t.id === templateId);
    if (template) {
      const newTemplate: MessageTemplate = {
        ...template,
        id: Date.now().toString(),
        name: `${template.name} (Copy)`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setTemplates([...templates, newTemplate]);
      toast.info(`Created a copy of "${template.name}"`, { title: 'Template duplicated' });
    }
  };

  const startRenaming = (templateId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setIsRenaming(templateId);
      setEditingTemplateName(template.name);
    }
  };

  const saveRename = (templateId: string) => {
    if (editingTemplateName.trim()) {
      setTemplates(templates.map(t =>
        t.id === templateId
          ? { ...t, name: editingTemplateName.trim(), updatedAt: new Date().toISOString() }
          : t
      ));
    }
    setIsRenaming(null);
    setEditingTemplateName('');
  };

  const startNewTemplate = () => {
    if (messageTemplate || variableTitlePairs.length > 0) {
      if (!confirm('This will clear your current template. Continue?')) return;
    }
    setCurrentTemplateId(null);
    setMessageTemplate('');
    setVariableTitlePairs([]);
    setSelectedContacts([]);
    setIsTemplateManagerOpen(false);
  };

  const clearMessage = () => {
    if (!messageTemplate) return;
    if (confirm('Clear the message content? This won\u2019t delete a saved template.')) {
      setMessageTemplate('');
    }
  };

  // Contact assignment dialog
  const ContactAssignmentDialog = ({ templateId, currentContacts }: { templateId: string, currentContacts: string[] }) => {
    const [selected, setSelected] = useState<string[]>(currentContacts);
    const [searchTerm, setSearchTerm] = useState('');

    const filteredContacts = contacts.filter(contact =>
      contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      contact.phoneNumber.includes(searchTerm)
    );

    const toggleContact = (contactId: string) => {
      setSelected(prev =>
        prev.includes(contactId)
          ? prev.filter(id => id !== contactId)
          : [...prev, contactId]
      );
    };

    const selectAll = () => {
      setSelected(contacts.map(c => c.id));
    };

    const clearAll = () => {
      setSelected([]);
    };

    return (
      <div className="rounded-xl border p-4 space-y-3 bg-background shadow-sm">
        <div className="flex items-center justify-between">
          <h4 className="font-medium flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Assign Contacts
          </h4>
          <div className="flex space-x-2">
            <Button variant="outline" size="sm" onClick={selectAll}>
              Select all
            </Button>
            <Button variant="outline" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            className="w-full rounded-md border border-input pl-9 pr-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Search by name or number..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="max-h-[220px] overflow-y-auto space-y-1 pr-1">
          {filteredContacts.length === 0 ? (
            <div className="text-center text-muted-foreground py-6 text-sm">
              <Search className="h-5 w-5 mx-auto mb-1.5 opacity-50" />
              No contacts match "{searchTerm}"
            </div>
          ) : (
            filteredContacts.map((contact) => (
              <label
                key={contact.id}
                className="flex items-center space-x-3 p-2 rounded-lg border hover:bg-accent cursor-pointer transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(contact.id)}
                  onChange={() => toggleContact(contact.id)}
                  className="h-4 w-4 accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{contact.name}</p>
                  <p className="text-xs text-muted-foreground">{contact.phoneNumber}</p>
                </div>
                {contact.nicknames.length > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {contact.nicknames.join(', ')}
                  </span>
                )}
              </label>
            ))
          )}
        </div>

        <div className="flex justify-between items-center pt-2 border-t">
          <span className="text-sm font-medium">
            {selected.length} contact{selected.length === 1 ? '' : 's'} selected
          </span>
          <div className="flex space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsAssigningContacts(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateTemplateContacts(templateId, selected)}
            >
              <Check className="h-4 w-4 mr-1" />
              Assign contacts
            </Button>
          </div>
        </div>
      </div>
    );
  };

  // Existing functions
  const getFullPreview = () => {
    return buildMessageFromTemplate({
      content: messageTemplate,
      variables: variables.map((v) => ({ name: v.name, value: v.value || '(empty)' })),
      variableTitlePairs,
      layout: globalLayout,
    });
  };

  const previewText = getFullPreview();
  const segmentCount = estimateSmsSegments(previewText.length);

  const addVariableTitlePair = () => {
    if (editingPair.variableName && editingPair.title) {
      const newPair: VariableTitlePair = {
        id: Date.now().toString(),
        variableName: editingPair.variableName,
        title: editingPair.title,
        displayName: `${editingPair.title} (${editingPair.variableName})`,
      };
      setVariableTitlePairs([...variableTitlePairs, newPair]);
      setEditingPair({});
      setIsAddingPair(false);
    }
  };

  const removeVariableTitlePair = (id: string) => {
    setVariableTitlePairs(variableTitlePairs.filter(pair => pair.id !== id));
    if (editingPairId === id) {
      setEditingPairId(null);
      setEditingPair({});
    }
  };

  const startEditPair = (pair: VariableTitlePair) => {
    setEditingPair({ variableName: pair.variableName, title: pair.title });
    setEditingPairId(pair.id);
    setIsAddingPair(false);
  };

  const cancelEditPair = () => {
    setEditingPairId(null);
    setEditingPair({});
  };

  const updateVariableTitlePair = () => {
    if (editingPairId && editingPair.variableName && editingPair.title) {
      const updatedPairs = variableTitlePairs.map(pair =>
        pair.id === editingPairId
          ? {
              ...pair,
              variableName: editingPair.variableName!,
              title: editingPair.title!,
              displayName: `${editingPair.title} (${editingPair.variableName})`,
            }
          : pair
      );
      setVariableTitlePairs(updatedPairs);
      cancelEditPair();
    }
  };

  const movePair = (index: number, direction: 'up' | 'down') => {
    const newPairs = [...variableTitlePairs];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newPairs.length) return;

    [newPairs[index], newPairs[swapIndex]] = [newPairs[swapIndex], newPairs[index]];
    setVariableTitlePairs(newPairs);
  };

  const handleSendMessages = async () => {
    if (!messageTemplate || selectedContacts.length === 0) return;

    setIsSending(true);
    setStatus('idle');

    const messages = selectedContacts.map(contactId => {
      const contact = contacts.find(c => c.id === contactId);

      const fullMessage = buildMessageFromTemplate({
        content: messageTemplate,
        variables: variables.map((v) => ({ name: v.name, value: v.value })),
        variableTitlePairs,
        layout: globalLayout,
      });

      return {
        phoneNumber: contact?.phoneNumber || '',
        message: fullMessage,
        contactId,
        contactName: contact?.name || '',
      };
    });

    try {
      const results = await semaphoreAPI.sendBulkMessages(
        messages.map(m => ({ phoneNumber: m.phoneNumber, message: m.message }))
      );

      const logs: Array<{
        contactId: string;
        contactName: string;
        phoneNumber: string;
        message: string;
        status: 'sent' | 'failed';
        sentAt: string;
        variables: Record<string, string>;
      }> = [];

      results.forEach((result, index) => {
        logs.push({
          contactId: messages[index].contactId,
          contactName: messages[index].contactName,
          phoneNumber: messages[index].phoneNumber,
          message: messages[index].message,
          status: result.status === 'success' ? 'sent' : 'failed',
          sentAt: new Date().toISOString(),
          variables: variables.reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {}),
        });
      });

      addLogs(logs);

      const successCount = results.filter(r => r.status === 'success').length;
      setStatus('success');
      setStatusMessage(`Successfully sent ${successCount} of ${results.length} messages`);

      if (successCount === results.length) {
        toast.success(
          `Successfully sent ${successCount} message${successCount === 1 ? '' : 's'} to your selected recipients`,
          { title: 'Messages sent' }
        );
      } else if (successCount > 0) {
        toast.info(
          `Sent ${successCount} of ${results.length} messages. ${results.length - successCount} failed.`,
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
            ? `None of the ${results.length} messages could be sent. ${reasons.join(' · ')}`
            : `None of the ${results.length} messages could be sent. Check your Semaphore configuration.`,
          { title: 'Send failed', duration: 10000 }
        );
      }
    } catch {
      setStatus('error');
      setStatusMessage('Failed to send messages. Please check your configuration.');
      toast.error('Failed to send messages. Please check your Semaphore configuration.', {
        title: 'Send failed',
      });
    } finally {
      setIsSending(false);
    }
  };

  const toggleContact = (contactId: string) => {
    setSelectedContacts(prev =>
      prev.includes(contactId)
        ? prev.filter(id => id !== contactId)
        : [...prev, contactId]
    );
  };

  const filteredMainContacts = contacts.filter(contact =>
    contact.name.toLowerCase().includes(contactSearchTerm.toLowerCase()) ||
    contact.phoneNumber.includes(contactSearchTerm) ||
    contact.nicknames.some(n => n.toLowerCase().includes(contactSearchTerm.toLowerCase()))
  );

  const filteredTemplates = templates.filter(t =>
    t.name.toLowerCase().includes(templateSearchTerm.toLowerCase())
  );

  const sendDisabledReason = !messageTemplate
    ? 'Write a message before sending'
    : selectedContacts.length === 0
    ? 'Select at least one recipient'
    : null;

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="h-6 w-6 text-primary" />
            Message Composer
          </h2>
          {activeTemplate ? (
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
              Editing
              <span className="font-medium text-foreground">{activeTemplate.name}</span>
              {hasUnsavedChanges && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                  Unsaved changes
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mt-0.5">
              Draft a new message, or open a saved template to edit it
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsTemplateManagerOpen(!isTemplateManagerOpen)}
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            Templates
            {templates.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs">{templates.length}</span>
            )}
          </Button>
          {currentTemplateId ? (
            <>
              <Button variant="outline" size="sm" onClick={saveCurrentTemplate}>
                <Save className="h-4 w-4 mr-2" />
                Save as new
              </Button>
              <Button size="sm" onClick={updateCurrentTemplate} disabled={!hasUnsavedChanges}>
                <Check className="h-4 w-4 mr-2" />
                Update template
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={saveCurrentTemplate} disabled={!messageTemplate}>
              <Save className="h-4 w-4 mr-2" />
              Save template
            </Button>
          )}
        </div>
      </div>

      {/* Template Manager Panel */}
      {isTemplateManagerOpen && (
        <div className="rounded-xl border bg-muted/30 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-background/60">
            <h3 className="font-semibold flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              Template Manager
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setIsTemplateManagerOpen(false)} className="h-8 w-8 p-0">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Click a template to open it in the composer, edit its content, then press{' '}
              <span className="font-medium text-foreground">Update template</span> to save your changes.
            </p>

            {templates.length > 0 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  className="w-full rounded-md border border-input pl-9 pr-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Search templates..."
                  value={templateSearchTerm}
                  onChange={(e) => setTemplateSearchTerm(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {templates.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                  <p className="text-muted-foreground text-sm">No templates saved yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Write a message below, then save it as your first template.</p>
                </div>
              ) : filteredTemplates.length === 0 ? (
                <p className="text-center text-muted-foreground py-6 text-sm">
                  No templates match "{templateSearchTerm}"
                </p>
              ) : (
                filteredTemplates.map((template) => (
                  <div
                    key={template.id}
                    className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                      currentTemplateId === template.id ? 'bg-primary/10 border-primary' : 'bg-background hover:bg-accent'
                    } cursor-pointer group`}
                  >
                    <div className="flex-1 min-w-0" onClick={() => loadTemplate(template.id)}>
                      {isRenaming === template.id ? (
                        <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            className="flex-1 rounded-md border border-input px-2 py-1 text-sm"
                            value={editingTemplateName}
                            onChange={(e) => setEditingTemplateName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveRename(template.id)}
                            autoFocus
                          />
                          <Button size="sm" variant="ghost" onClick={() => saveRename(template.id)}>
                            <Check className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium truncate">{template.name}</p>
                            {currentTemplateId === template.id && (
                              <span className="text-xs text-primary font-medium">Active</span>
                            )}
                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full flex items-center shrink-0">
                              <Users className="h-3 w-3 mr-1" />
                              {template.assignedContactIds?.length || 0}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Updated {new Date(template.updatedAt).toLocaleDateString()}
                          </p>
                        </>
                      )}
                    </div>

                    <div className="flex items-center space-x-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsAssigningContacts(template.id);
                        }}
                        className="h-8 w-8 p-0"
                        title="Assign contacts"
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => startRenaming(template.id, e)}
                        className="h-8 w-8 p-0"
                        title="Rename"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => duplicateTemplate(template.id, e)}
                        className="h-8 w-8 p-0"
                        title="Duplicate"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => deleteTemplate(template.id, e)}
                        className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Contact Assignment Dialog */}
            {isAssigningContacts && (
              <ContactAssignmentDialog
                templateId={isAssigningContacts}
                currentContacts={templates.find(t => t.id === isAssigningContacts)?.assignedContactIds || []}
              />
            )}

            <div className="flex justify-end pt-2 border-t">
              <Button variant="outline" size="sm" onClick={startNewTemplate}>
                <Plus className="h-4 w-4 mr-1" />
                New template
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Global Header & Footer */}
      <div className="rounded-xl border bg-muted/20 overflow-hidden">
        <button
          type="button"
          onClick={() => setIsLayoutOpen(!isLayoutOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            {isLayoutOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="font-semibold">Global header &amp; footer</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Applied to all templates
            </span>
          </div>
          {(globalLayout.header || globalLayout.footer) && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Set
            </span>
          )}
        </button>

        {isLayoutOpen && (
          <div className="space-y-4 px-4 pb-4 pt-1 border-t">
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <Heading1 className="h-4 w-4 text-primary" />
                <Label>Header (prepended to every message)</Label>
              </div>
              <textarea
                className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={globalLayout.header}
                onChange={(e) =>
                  setGlobalLayout((prev) => ({ ...prev, header: e.target.value }))
                }
                placeholder="e.g. Greetings, {{Name}}! Here's your schedule:"
                rows={2}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <Quote className="h-4 w-4 text-primary" />
                <Label>Footer (appended to every message)</Label>
              </div>
              <textarea
                className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={globalLayout.footer}
                onChange={(e) =>
                  setGlobalLayout((prev) => ({ ...prev, footer: e.target.value }))
                }
                placeholder="e.g. God bless! - [Your Church]"
                rows={2}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              The header and footer are added to every message built from any template, including
              the live preview. They support the same{' '}
              <code className="rounded bg-muted px-1">{'{{variable}}'}</code> placeholders and save
              automatically as you type.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Edit2 className="h-4 w-4 text-primary" />
              Message Template
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Message</Label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {previewText.length} chars
                    {segmentCount > 0 && ` · ${segmentCount} segment${segmentCount === 1 ? '' : 's'}`}
                  </span>
                  {messageTemplate && (
                    <button
                      type="button"
                      onClick={clearMessage}
                      className="text-xs text-muted-foreground hover:text-red-600 flex items-center gap-1 transition-colors"
                      title="Clear message"
                    >
                      <Eraser className="h-3 w-3" />
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <textarea
                className="w-full min-h-[150px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={messageTemplate}
                onChange={(e) => setMessageTemplate(e.target.value)}
                placeholder="Type your message here. Use the tabs below to insert variables or title-value pairs."
              />
            </div>

            {/* Insertable content: tabbed to reduce clutter */}
            <div className="border rounded-lg overflow-hidden">
              <div className="flex border-b bg-muted/30">
                <button
                  type="button"
                  onClick={() => setInsertTab('variables')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                    insertTab === 'variables'
                      ? 'bg-background text-foreground border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Variables
                  {variables.length > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-xs">{variables.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setInsertTab('pairs')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                    insertTab === 'pairs'
                      ? 'bg-background text-foreground border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Tag className="h-3.5 w-3.5" />
                  Title-value pairs
                  {variableTitlePairs.length > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-xs">{variableTitlePairs.length}</span>
                  )}
                </button>
              </div>

              <div className="p-3 space-y-3">
                {insertTab === 'variables' && (
                  variables.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-3">
                      No FreeShow variables detected yet.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {variables.map((variable) => (
                        <Button
                          key={variable.id}
                          variant="outline"
                          size="sm"
                          onClick={() => insertVariable(variable.name)}
                        >
                          {`{{${variable.name}}}`}
                        </Button>
                      ))}
                    </div>
                  )
                )}

                {insertTab === 'pairs' && (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        Create a "Title: Value" line, then insert it wherever you like in the message.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsAddingPair(true)}
                        disabled={isAddingPair}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        New pair
                      </Button>
                    </div>

                    <div className="space-y-2">
                      {variableTitlePairs.map((pair, index) => (
                        <div key={pair.id} className="flex items-center justify-between bg-muted p-2 rounded-lg">
                          <div className="flex items-center space-x-2 flex-1 min-w-0">
                            <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="text-sm truncate">
                              <span className="font-medium">{pair.title}</span>
                              <span className="text-muted-foreground mx-2">&rarr;</span>
                              <span className="text-blue-600">{pair.variableName}</span>
                            </span>
                          </div>
                          <div className="flex items-center space-x-0.5 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => insertTitlePair(pair.id)}
                              className="h-7 px-2 text-xs"
                            >
                              Insert
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEditPair(pair)}
                              aria-label="Edit pair"
                              className="h-7 w-7 p-0"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => movePair(index, 'up')}
                              disabled={index === 0}
                              className="h-7 w-7 p-0"
                              aria-label="Move up"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => movePair(index, 'down')}
                              disabled={index === variableTitlePairs.length - 1}
                              className="h-7 w-7 p-0"
                              aria-label="Move down"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeVariableTitlePair(pair.id)}
                              className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                              aria-label="Remove pair"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                      {variableTitlePairs.length === 0 && !isAddingPair && (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No pairs yet. Create one to insert a formatted "Title: Value" line.
                        </p>
                      )}
                    </div>

                    {isAddingPair && (
                      <div className="border rounded-lg p-3 space-y-3 bg-background">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Title</Label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-input px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              placeholder="e.g., Event Name"
                              value={editingPair.title || ''}
                              onChange={(e) => setEditingPair({ ...editingPair, title: e.target.value })}
                              autoFocus
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Variable</Label>
                            <select
                              className="w-full rounded-md border border-input px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={editingPair.variableName || ''}
                              onChange={(e) => setEditingPair({ ...editingPair, variableName: e.target.value })}
                            >
                              <option value="">Select variable</option>
                              {variables.map((v) => (
                                <option key={v.id} value={v.name}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="flex justify-end space-x-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setIsAddingPair(false);
                              setEditingPair({});
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={addVariableTitlePair}
                            disabled={!editingPair.variableName || !editingPair.title}
                          >
                            Create pair
                          </Button>
                        </div>
                      </div>
                    )}

                    {editingPairId && !isAddingPair && (
                      <div className="border rounded-lg p-3 space-y-3 bg-background border-blue-300">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold text-blue-700">Edit pair</Label>
                          <Button variant="ghost" size="sm" onClick={cancelEditPair} className="h-6 w-6 p-0">
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Title</Label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-input px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              placeholder="e.g., Event Name"
                              value={editingPair.title || ''}
                              onChange={(e) => setEditingPair({ ...editingPair, title: e.target.value })}
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Variable</Label>
                            <select
                              className="w-full rounded-md border border-input px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={editingPair.variableName || ''}
                              onChange={(e) => setEditingPair({ ...editingPair, variableName: e.target.value })}
                            >
                              <option value="">Select variable</option>
                              {variables.map((v) => (
                                <option key={v.id} value={v.name}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="flex justify-end space-x-2">
                          <Button variant="outline" size="sm" onClick={cancelEditPair}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={updateVariableTitlePair}
                            disabled={!editingPair.variableName || !editingPair.title}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Save pair
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Live preview</Label>
                {previewText && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {segmentCount} SMS segment{segmentCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {previewText ? (
                <div className="text-sm whitespace-pre-wrap rounded-md bg-background border p-3">
                  {previewText}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic py-2">
                  Your message preview will appear here as you type.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                Select Recipients
              </CardTitle>
              {currentTemplateId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAssigningContacts(currentTemplateId)}
                >
                  <UserPlus className="h-4 w-4 mr-1" />
                  Manage
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {activeTemplate && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                  <p className="flex items-center text-blue-800">
                    <Users className="h-4 w-4 mr-2 shrink-0" />
                    Template has <strong className="mx-1">{selectedContacts.length}</strong> assigned contact{selectedContacts.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-blue-600 mt-1">
                    {selectedContacts.length > 0
                      ? `Ready to send to ${selectedContacts.length} recipient${selectedContacts.length === 1 ? '' : 's'}`
                      : 'No contacts assigned to this template yet'}
                  </p>
                </div>
              )}

              {contacts.length > 0 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    className="w-full rounded-md border border-input pl-9 pr-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="Search contacts by name, number, or nickname..."
                    value={contactSearchTerm}
                    onChange={(e) => setContactSearchTerm(e.target.value)}
                  />
                </div>
              )}

              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {contacts.length === 0 ? (
                  <div className="text-center py-8">
                    <UserPlus className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground text-sm">No contacts available</p>
                    <p className="text-xs text-muted-foreground mt-1">Add contacts first to start sending messages.</p>
                  </div>
                ) : filteredMainContacts.length === 0 ? (
                  <p className="text-center text-muted-foreground py-6 text-sm">
                    No contacts match "{contactSearchTerm}"
                  </p>
                ) : (
                  filteredMainContacts.map((contact) => (
                    <label
                      key={contact.id}
                      className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                    >
                      <input
                        type="checkbox"
                        checked={selectedContacts.includes(contact.id)}
                        onChange={() => toggleContact(contact.id)}
                        className="h-4 w-4 accent-primary shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{contact.name}</p>
                        <p className="text-sm text-muted-foreground">{contact.phoneNumber}</p>
                        {contact.nicknames.length > 0 && (
                          <p className="text-xs text-muted-foreground truncate">
                            Nicknames: {contact.nicknames.join(', ')}
                          </p>
                        )}
                      </div>
                    </label>
                  ))
                )}
              </div>

              {contacts.length > 0 && (
                <div className="flex justify-between items-center pt-2 border-t">
                  <span className="text-sm font-medium">
                    {selectedContacts.length} of {contacts.length} selected
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (selectedContacts.length === contacts.length) {
                        setSelectedContacts([]);
                      } else {
                        setSelectedContacts(contacts.map(c => c.id));
                      }
                    }}
                  >
                    {selectedContacts.length === contacts.length ? 'Deselect all' : 'Select all'}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {status !== 'idle' && (
        <div className={`p-4 rounded-lg border ${
          status === 'success'
            ? 'bg-green-50 text-green-800 border-green-200'
            : 'bg-red-50 text-red-800 border-red-200'
        }`}>
          <div className="flex items-center">
            {status === 'success' ? (
              <CheckCircle2 className="h-5 w-5 mr-2 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 mr-2 shrink-0" />
            )}
            <p className="text-sm">{statusMessage}</p>
          </div>
        </div>
      )}

      {/* Sticky send bar so the primary action is always reachable */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="text-sm text-muted-foreground">
            {sendDisabledReason ? (
              <span>{sendDisabledReason}</span>
            ) : (
              <span>
                Sending to <strong className="text-foreground">{selectedContacts.length}</strong> recipient{selectedContacts.length === 1 ? '' : 's'}
                {segmentCount > 1 && ` · ${segmentCount} SMS segments each`}
              </span>
            )}
          </div>
          <Button
            onClick={handleSendMessages}
            disabled={!!sendDisabledReason || isSending}
            title={sendDisabledReason ?? undefined}
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {isSending ? 'Sending...' : `Send to ${selectedContacts.length} recipient${selectedContacts.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
}