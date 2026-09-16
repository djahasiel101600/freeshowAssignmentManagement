import { useEffect, useMemo, useRef, useState } from 'react';
import type { Contact } from '../types/contacts';
import { Users, ChevronsUpDown, Check } from 'lucide-react';
import { cn } from '../lib/utils';

interface ContactNameComboboxProps {
  value: string;
  onChange: (value: string) => void;
  contacts: Contact[];
  placeholder?: string;
}

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Free-text input backed by a suggestion dropdown of contact names.
 * - Focus or click the chevron to see the full contact list first.
 * - Typing filters the suggestions to matching names/nicknames.
 * - If nothing matches, the typed value is kept as a custom value.
 */
export function ContactNameCombobox({
  value,
  onChange,
  contacts,
  placeholder,
}: ContactNameComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    const term = normalize(value);
    if (!term) return contacts;
    return contacts.filter(
      (contact) =>
        normalize(contact.name).includes(term) ||
        contact.nicknames.some((nickname) => normalize(nickname).includes(term))
    );
  }, [contacts, value]);

  const exactMatch = useMemo(() => {
    const term = normalize(value);
    if (!term) return false;
    return contacts.some((contact) => normalize(contact.name) === term);
  }, [contacts, value]);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const openList = () => {
    setOpen(true);
    setHighlightIndex(0);
  };

  const selectContact = (contact: Contact) => {
    onChange(contact.name);
    setOpen(false);
  };

const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      setOpen(true);
      setHighlightIndex(0);
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, Math.max(suggestions.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      const selected = suggestions[highlightIndex];
      if (selected) {
        event.preventDefault();
        selectContact(selected);
      } else {
        setOpen(false);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showCustomHint = open && value.trim() !== '' && !exactMatch;

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <Users className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            openList();
          }}
          onFocus={openList}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Type a value or pick a contact...'}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          aria-haspopup="listbox"
          aria-expanded={open}
        />
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openList())}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Toggle contact suggestions"
          tabIndex={-1}
        >
          <ChevronsUpDown className="h-4 w-4" />
        </button>
      </div>
{open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="max-h-56 overflow-y-auto py-1">
            {suggestions.length === 0 ? (
              <div className="px-3 py-2 text-sm">
                {value.trim() ? (
                  <p className="text-muted-foreground">
                    No matching contacts — you can use{' '}
                    <span className="font-medium text-foreground">"{value.trim()}"</span> as a
                    custom value.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    No contacts yet. Add them on the Contacts page.
                  </p>
                )}
              </div>
            ) : (
              suggestions.slice(0, 20).map((contact, index) => {
                const isSelected = normalize(contact.name) === normalize(value);
                const isHighlighted = index === highlightIndex;
                return (
                  <button
                    type="button"
                    key={contact.id}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectContact(contact)}
                    onMouseEnter={() => setHighlightIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                      isHighlighted ? 'bg-muted text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    <Users className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {contact.name}
                    </span>
                    {contact.nicknames.length > 0 && (
                      <span className="truncate text-xs text-muted-foreground">
                        {contact.nicknames.join(', ')}
                      </span>
                    )}
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>

          {showCustomHint && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">Custom</span>
              <span className="min-w-0 flex-1 truncate">Use "{value.trim()}" as-is</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}