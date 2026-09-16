import { useEffect, useMemo, useRef, useState } from 'react';
import { useFreeShowVariables } from '../hooks/useFreeShowVariables';
import { useContacts } from '../hooks/useContacts';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useToast } from './ui/toast';
import { ContactNameCombobox } from './ContactNameCombobox';
import type { FreeShowVariable } from '../types/freeshow';
import {
  RefreshCw, Edit2, Save, X, FolderPlus, Folder,
  ChevronDown, ChevronRight, Trash2, Pencil,
  FolderOpen, Inbox, Search, Grid, List, WifiOff, RotateCw,
  GripVertical, Copy, Check, ChevronsUpDown, ChevronsDownUp, FolderInput
} from 'lucide-react';

interface VariableGroup {
  id: string;
  name: string;
  variableIds: string[];
  expanded?: boolean;
}

// Stable, deterministic color assignment per group so colors don't shift
// around as groups are added/removed/reordered.
const GROUP_COLORS = [
  { dot: 'bg-blue-500', border: 'border-l-blue-500', ring: 'ring-blue-500' },
  { dot: 'bg-purple-500', border: 'border-l-purple-500', ring: 'ring-purple-500' },
  { dot: 'bg-emerald-500', border: 'border-l-emerald-500', ring: 'ring-emerald-500' },
  { dot: 'bg-amber-500', border: 'border-l-amber-500', ring: 'ring-amber-500' },
  { dot: 'bg-rose-500', border: 'border-l-rose-500', ring: 'ring-rose-500' },
  { dot: 'bg-cyan-500', border: 'border-l-cyan-500', ring: 'ring-cyan-500' },
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getGroupColor(groupId: string) {
  return GROUP_COLORS[hashString(groupId) % GROUP_COLORS.length];
}

// Sentinel used for the "unassigned" drop target since it isn't a real group.
const UNASSIGNED = '__unassigned__';

export function VariablesManager() {
  const { variables, isLoading, error, refetch, updateVariableAsync, isUpdating } = useFreeShowVariables();
  const { contacts } = useContacts();
  const { info, success, error: toastError } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openMoveMenuId, setOpenMoveMenuId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Group management state
  const [groups, setGroups] = useState<VariableGroup[]>(() => {
    const saved = localStorage.getItem('variableGroups');
    return saved ? JSON.parse(saved) : [];
  });
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [showUnassigned, setShowUnassigned] = useState(true);

  // Save groups to localStorage
  useEffect(() => {
    localStorage.setItem('variableGroups', JSON.stringify(groups));
  }, [groups]);

  // Group management functions
  const createGroup = () => {
    if (!newGroupName.trim()) return;

    const newGroup: VariableGroup = {
      id: Date.now().toString(),
      name: newGroupName.trim(),
      variableIds: [],
      expanded: true
    };

    setGroups([...groups, newGroup]);
    setNewGroupName('');
    setIsCreatingGroup(false);
    info(`Group "${newGroup.name}" created`, { title: 'Group created' });
  };

  const deleteGroup = (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (confirm(`Delete group "${group?.name}"? Its variables will move to "Unassigned".`)) {
      setGroups(groups.filter(g => g.id !== groupId));
      info(`Group "${group?.name}" deleted`, { title: 'Group deleted' });
    }
  };

  const renameGroup = (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (group && editingGroupName.trim()) {
      setGroups(groups.map(g =>
        g.id === groupId
          ? { ...g, name: editingGroupName.trim() }
          : g
      ));
      info(`Group renamed to "${editingGroupName.trim()}"`, { title: 'Group renamed' });
    }
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const toggleGroupExpand = (groupId: string) => {
    setGroups(groups.map(g =>
      g.id === groupId
        ? { ...g, expanded: !g.expanded }
        : g
    ));
  };

  const allExpanded = groups.length > 0 && groups.every(g => g.expanded !== false);
  const toggleExpandAll = () => {
    const nextState = !allExpanded;
    setGroups(groups.map(g => ({ ...g, expanded: nextState })));
  };

  const assignVariableToGroup = (variableId: string, groupId: string, opts?: { silent?: boolean }) => {
    const targetGroup = groups.find(g => g.id === groupId);
    const wasAlreadyThere = targetGroup?.variableIds.includes(variableId);

    // Remove variable from all groups, then add to the selected one.
    const updatedGroups = groups.map(g => ({
      ...g,
      variableIds: g.variableIds.filter(id => id !== variableId)
    }));
    const finalGroups = updatedGroups.map(g =>
      g.id === groupId
        ? { ...g, variableIds: [...g.variableIds, variableId] }
        : g
    );

    setGroups(finalGroups);

    if (!opts?.silent && !wasAlreadyThere && targetGroup) {
      const variable = variables.find(v => v.id === variableId);
      info(`Moved "${variable?.name ?? 'Variable'}" to "${targetGroup.name}"`, { title: 'Variable moved' });
    }
  };

  const unassignVariable = (variableId: string, opts?: { silent?: boolean }) => {
    const wasAssigned = groups.some(g => g.variableIds.includes(variableId));
    if (!wasAssigned) return;

    setGroups(groups.map(g => ({
      ...g,
      variableIds: g.variableIds.filter(id => id !== variableId)
    })));

    if (!opts?.silent) {
      const variable = variables.find(v => v.id === variableId);
      info(`Moved "${variable?.name ?? 'Variable'}" to Unassigned`, { title: 'Variable moved' });
    }
  };

  const removeVariableFromGroup = (variableId: string, groupId: string) => {
    setGroups(groups.map(g =>
      g.id === groupId
        ? { ...g, variableIds: g.variableIds.filter(id => id !== variableId) }
        : g
    ));
  };

  const getUnassignedVariables = () => {
    const assignedIds = groups.flatMap(g => g.variableIds);
    return variables.filter(v => !assignedIds.includes(v.id));
  };

  const getGroupVariables = (group: VariableGroup) => {
    return variables.filter(v => group.variableIds.includes(v.id));
  };

  const handleEdit = (variable: FreeShowVariable) => {
    setEditingId(variable.id);
    setEditValue(variable.value);
  };

  const handleSave = async (id: string) => {
    const value = editValue;
    setEditingId(null);
    try {
      await updateVariableAsync({ id, value });
      success('Variable change queued. It will appear in FreeShow shortly.', {
        title: 'Saved',
        duration: 4000,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not queue the variable change.';
      toastError(message, { title: 'Change not queued', duration: 10000 });
    }
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleCopy = async (variable: FreeShowVariable) => {
    if (!variable.value) return;
    try {
      await navigator.clipboard.writeText(variable.value);
      setCopiedId(variable.id);
      window.setTimeout(() => setCopiedId(prev => (prev === variable.id ? null : prev)), 1500);
    } catch {
      info('Could not copy to clipboard', { title: 'Copy failed' });
    }
  };

  // Filter variables based on search
  const filterVariables = (vars: FreeShowVariable[]) => {
    if (!searchTerm) return vars;
    const term = searchTerm.toLowerCase();
    return vars.filter(v =>
      v.name.toLowerCase().includes(term) ||
      v.value.toLowerCase().includes(term)
    );
  };

  const totalMatches = useMemo(() => {
    if (!searchTerm) return variables.length;
    return filterVariables(variables).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, variables]);

  // Drag and drop handlers ---------------------------------------------
  const handleDragStart = (e: React.DragEvent, variableId: string) => {
    e.dataTransfer.setData('text/plain', variableId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(variableId);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverTarget(null);
  };

  const handleDropOnGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    const variableId = e.dataTransfer.getData('text/plain');
    if (variableId) assignVariableToGroup(variableId, groupId);
    setDragOverTarget(null);
    setDraggingId(null);
  };

  const handleDropOnUnassigned = (e: React.DragEvent) => {
    e.preventDefault();
    const variableId = e.dataTransfer.getData('text/plain');
    if (variableId) unassignVariable(variableId);
    setDragOverTarget(null);
    setDraggingId(null);
  };

  const allowDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverTarget !== targetId) setDragOverTarget(targetId);
  };

  // Render "move to group" menu (accessible fallback to drag-and-drop)
  const renderMoveMenu = (variable: FreeShowVariable, currentGroupId?: string) => {
    const isOpen = openMoveMenuId === variable.id;
    return (
      <div
        className="relative"
        tabIndex={-1}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setOpenMoveMenuId(null);
          }
        }}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpenMoveMenuId(isOpen ? null : variable.id)}
          aria-haspopup="menu"
          aria-expanded={isOpen}
        >
          <FolderInput className="h-4 w-4 mr-1" />
          Move
        </Button>
        {isOpen && (
          <div
            role="menu"
            className="absolute z-10 mt-1 min-w-[10rem] rounded-md border bg-popover shadow-md py-1"
          >
            {currentGroupId && (
              <button
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted"
                onClick={() => {
                  unassignVariable(variable.id);
                  setOpenMoveMenuId(null);
                }}
              >
                <Inbox className="h-3.5 w-3.5" />
                Unassigned
              </button>
            )}
            {groups
              .filter(g => g.id !== currentGroupId)
              .map(g => (
                <button
                  key={g.id}
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted"
                  onClick={() => {
                    assignVariableToGroup(variable.id, g.id);
                    setOpenMoveMenuId(null);
                  }}
                >
                  <span className={`h-2 w-2 rounded-full ${getGroupColor(g.id).dot}`} />
                  {g.name}
                </button>
              ))}
            {groups.length === 0 && (
              <p className="px-3 py-1.5 text-sm text-muted-foreground">No groups yet</p>
            )}
          </div>
        )}
      </div>
    );
  };

  // Render variable card
  const renderVariableCard = (variable: FreeShowVariable, groupId?: string) => {
    const isEditing = editingId === variable.id;
    const isDragging = draggingId === variable.id;
    const isCopied = copiedId === variable.id;

    return (
      <Card
        key={variable.id}
        draggable={!isEditing}
        onDragStart={(e) => handleDragStart(e, variable.id)}
        onDragEnd={handleDragEnd}
        className={`relative transition-all ${isDragging ? 'opacity-40' : ''} ${
          !isEditing ? 'hover:shadow-md hover:-translate-y-0.5 cursor-grab active:cursor-grabbing' : ''
        }`}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {!isEditing && (
                <GripVertical className="h-4 w-4 flex-none text-muted-foreground/50" aria-hidden="true" />
              )}
              <CardTitle className="text-lg truncate" title={variable.name}>
                {variable.name}
              </CardTitle>
            </div>
            {groupId && !isEditing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeVariableFromGroup(variable.id, groupId)}
                className="h-6 w-6 p-0 flex-none text-muted-foreground hover:text-red-600"
                title="Remove from group"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <div className="space-y-2">
              <ContactNameCombobox
                value={editValue}
                onChange={setEditValue}
                contacts={contacts}
                placeholder={`Set value for "${variable.name}"...`}
              />
              <p className="text-xs text-muted-foreground">
                Pick a contact name from the suggestions, or type any custom value.
              </p>
              <div className="flex space-x-2">
                <Button
                  size="sm"
                  onClick={() => handleSave(variable.id)}
                  disabled={isUpdating}
                >
                  <Save className="h-4 w-4 mr-1" />
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                >
                  <X className="h-4 w-4 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-1.5">
                {variable.value ? (
                  <button
                    onClick={() => handleCopy(variable)}
                    className="group flex min-w-0 items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground"
                    title="Copy value"
                  >
                    <span className="truncate break-all text-left">{variable.value}</span>
                    {isCopied ? (
                      <Check className="h-3.5 w-3.5 flex-none text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 flex-none opacity-0 group-hover:opacity-100" />
                    )}
                  </button>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    No value set
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleEdit(variable)}
                >
                  <Edit2 className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                {renderMoveMenu(variable, groupId)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-7 w-56 rounded bg-muted animate-pulse" />
          <div className="h-9 w-40 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-lg border bg-muted/40 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <WifiOff className="h-7 w-7 text-destructive" />
        </div>
        <div>
          <h3 className="mb-1 font-semibold">Can't reach FreeShow</h3>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            FreeShow's API isn't responding. Make sure FreeShow is running and the correct
            port is set in Settings, then try again.
          </p>
        </div>
        <Button onClick={() => refetch()} variant="outline">
          <RotateCw className="h-4 w-4 mr-2" />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-4 border-b bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center space-x-4">
          <h2 className="text-2xl font-bold">
            FreeShow Variables <span className="text-muted-foreground font-normal">({variables.length})</span>
          </h2>
          <div className="flex items-center space-x-1 rounded-md border p-0.5">
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              <Grid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('list')}
              title="List view"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search variables..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearchTerm('')}
              className="pl-9 pr-8 w-48"
            />
            {searchTerm && (
              <button
                onClick={() => {
                  setSearchTerm('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {searchTerm && (
        <p className="text-sm text-muted-foreground">
          {totalMatches === 0
            ? `No variables match "${searchTerm}"`
            : `${totalMatches} of ${variables.length} variables match "${searchTerm}"`}
        </p>
      )}

      {/* Group Management */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-2">
            <h3 className="font-semibold text-lg">Groups</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreatingGroup(true)}
            >
              <FolderPlus className="h-4 w-4 mr-1" />
              New Group
            </Button>
            {groups.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleExpandAll}
              >
                {allExpanded ? (
                  <ChevronsDownUp className="h-4 w-4 mr-1" />
                ) : (
                  <ChevronsUpDown className="h-4 w-4 mr-1" />
                )}
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowUnassigned(!showUnassigned)}
            >
              {showUnassigned ? 'Hide' : 'Show'} Unassigned
              <span className="ml-1 text-xs bg-muted px-1.5 py-0.5 rounded">
                {getUnassignedVariables().length}
              </span>
            </Button>
          </div>
          {groups.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Drag a variable card onto a group to move it
            </p>
          )}
        </div>

        {/* Create Group Form */}
        {isCreatingGroup && (
          <div className="border rounded-lg p-4 bg-muted/30">
            <div className="flex items-center space-x-2">
              <Input
                placeholder="Enter group name..."
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="max-w-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createGroup();
                  if (e.key === 'Escape') {
                    setIsCreatingGroup(false);
                    setNewGroupName('');
                  }
                }}
                autoFocus
              />
              <Button size="sm" onClick={createGroup} disabled={!newGroupName.trim()}>
                <FolderPlus className="h-4 w-4 mr-1" />
                Create
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsCreatingGroup(false);
                  setNewGroupName('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Groups Display */}
        {groups.length === 0 && !isCreatingGroup && (
          <div className="text-center text-muted-foreground py-10 border border-dashed rounded-lg">
            <FolderOpen className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p className="font-medium text-foreground">No groups yet</p>
            <p className="text-sm mb-4">Create a group to start organizing your variables.</p>
            <Button variant="outline" size="sm" onClick={() => setIsCreatingGroup(true)}>
              <FolderPlus className="h-4 w-4 mr-1" />
              New Group
            </Button>
          </div>
        )}

        {groups.map((group) => {
          const groupVariables = getGroupVariables(group);
          const filteredVariables = filterVariables(groupVariables);
          const color = getGroupColor(group.id);
          const isDropTarget = dragOverTarget === group.id;

          return (
            <div
              key={group.id}
              className={`border rounded-lg overflow-hidden transition-shadow ${
                isDropTarget ? `ring-2 ${color.ring} ring-offset-1` : ''
              }`}
              onDragOver={(e) => allowDrop(e, group.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverTarget(null);
              }}
              onDrop={(e) => handleDropOnGroup(e, group.id)}
            >
              {/* Group Header */}
              <div
                className={`flex items-center justify-between p-3 bg-muted/30 hover:bg-muted/50 cursor-pointer border-l-4 ${color.border}`}
                onClick={() => toggleGroupExpand(group.id)}
              >
                <div className="flex items-center space-x-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroupExpand(group.id);
                    }}
                  >
                    {group.expanded !== false ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                  <span className={`h-2.5 w-2.5 rounded-full flex-none ${color.dot}`} aria-hidden="true" />
                  <Folder className="h-5 w-5 text-muted-foreground" />

                  {editingGroupId === group.id ? (
                    <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                      <Input
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        className="h-8 max-w-xs"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameGroup(group.id);
                          if (e.key === 'Escape') {
                            setEditingGroupId(null);
                            setEditingGroupName('');
                          }
                        }}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => renameGroup(group.id)}
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <span className="font-medium">{group.name}</span>
                  )}

                  <span className="text-xs text-muted-foreground">
                    {groupVariables.length} variable{groupVariables.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="flex items-center space-x-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingGroupId(group.id);
                      setEditingGroupName(group.name);
                    }}
                    className="h-8 w-8 p-0"
                    title="Rename group"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteGroup(group.id)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-red-600"
                    title="Delete group"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Group Content */}
              {group.expanded !== false && (
                <div className={`p-3 ${isDropTarget ? 'bg-muted/20' : ''}`}>
                  {groupVariables.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-1 py-6 text-center text-sm text-muted-foreground">
                      <Inbox className="h-6 w-6 opacity-40" />
                      <p>Drag variables here, or use "Move" on a card</p>
                    </div>
                  ) : filteredVariables.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No matching variables in this group
                    </p>
                  ) : (
                    <div className={`grid gap-4 ${
                      viewMode === 'grid'
                        ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
                        : 'grid-cols-1'
                    }`}>
                      {filteredVariables.map(v => renderVariableCard(v, group.id))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Unassigned Variables */}
        {showUnassigned && getUnassignedVariables().length > 0 && (
          <div
            className={`border rounded-lg transition-shadow ${
              dragOverTarget === UNASSIGNED ? 'ring-2 ring-muted-foreground/40 ring-offset-1' : ''
            }`}
            onDragOver={(e) => allowDrop(e, UNASSIGNED)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverTarget(null);
            }}
            onDrop={handleDropOnUnassigned}
          >
            <div className="p-3 bg-muted/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <Inbox className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium">Unassigned Variables</span>
                  <span className="text-xs text-muted-foreground">
                    {getUnassignedVariables().length} variable(s)
                  </span>
                </div>
              </div>
            </div>
            <div className={`p-3 ${dragOverTarget === UNASSIGNED ? 'bg-muted/20' : ''}`}>
              {filterVariables(getUnassignedVariables()).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No matching unassigned variables
                </p>
              ) : (
                <div className={`grid gap-4 ${
                  viewMode === 'grid'
                    ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
                    : 'grid-cols-1'
                }`}>
                  {filterVariables(getUnassignedVariables()).map(v => renderVariableCard(v))}
                </div>
              )}
            </div>
          </div>
        )}

        {!showUnassigned && getUnassignedVariables().length === 0 && groups.length > 0 && (
          <p className="text-center text-sm text-muted-foreground py-2">
            Every variable is assigned to a group.
          </p>
        )}
      </div>
    </div>
  );
}