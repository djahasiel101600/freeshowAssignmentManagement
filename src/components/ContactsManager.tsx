import { useState, useMemo } from 'react';
import { useContacts } from '../hooks/useContacts';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import type { Contact } from '../types/contacts';
import { Plus, Trash2, Edit2, X, Check, UserPlus, Search, Phone, Users, Inbox } from 'lucide-react';

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function ContactManager() {
  const { contacts, addContact, updateContact, deleteContact, addNickname, removeNickname } = useContacts();
  const { info } = useToast();
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; phoneNumber: string } | null>(null);
  const [newNickname, setNewNickname] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    phoneNumber: '',
    nicknames: [] as string[],
  });

  const filteredContacts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return contacts;
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.phoneNumber.toLowerCase().includes(term) ||
        c.nicknames.some((n) => n.toLowerCase().includes(term))
    );
  }, [contacts, searchTerm]);

  const handleAddContact = () => {
    if (formData.name && formData.phoneNumber) {
      addContact(formData);
      setFormData({ name: '', phoneNumber: '', nicknames: [] });
      setIsAdding(false);
      info(`${formData.name} added to your contacts`, { title: 'Contact saved' });
    }
  };

  const handleAddNickname = (contactId: string) => {
    if (newNickname.trim()) {
      addNickname(contactId, newNickname.trim());
      setNewNickname('');
    }
  };

  const startEditContact = (contact: Contact) => {
    setEditingId(editingId === contact.id ? null : contact.id);
    setEditForm({ name: contact.name, phoneNumber: contact.phoneNumber });
    setNewNickname('');
  };

  const cancelEditContact = () => {
    setEditingId(null);
    setEditForm(null);
    setNewNickname('');
  };

  const saveEditContact = (contact: Contact) => {
    if (!editForm) return;
    const name = editForm.name.trim();
    const phoneNumber = editForm.phoneNumber.trim();
    if (!name || !phoneNumber) return;

    updateContact(contact.id, { name, phoneNumber });
    cancelEditContact();
    info(`Updated "${contact.name}"`, { title: 'Contact updated' });
  };

  const handleDeleteContact = (contact: Contact) => {
    if (confirm(`Delete "${contact.name}" and all their nicknames?`)) {
      deleteContact(contact.id);
      info(`${contact.name} removed from contacts`, { title: 'Contact deleted' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Contact List</h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {contacts.length} contact{contacts.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button onClick={() => setIsAdding(true)} disabled={isAdding}>
          <UserPlus className="h-4 w-4 mr-2" />
          Add Contact
        </Button>
      </div>

      {contacts.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by name, phone, or nickname..."
            className="pl-9"
            aria-label="Search contacts"
          />
        </div>
      )}

      {isAdding && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Contact name"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                value={formData.phoneNumber}
                onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
                placeholder="+639123456789"
              />
            </div>
          </CardContent>
          <CardFooter className="space-x-2">
            <Button onClick={handleAddContact} disabled={!formData.name || !formData.phoneNumber}>
              <Plus className="h-4 w-4 mr-2" />
              Save Contact
            </Button>
            <Button variant="outline" onClick={() => setIsAdding(false)}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}
{filteredContacts.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredContacts.map((contact) => (
            <Card key={contact.id} size="sm">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {getInitials(contact.name)}
                </div>
                <CardTitle className="min-w-0 flex-1 truncate text-lg">{contact.name}</CardTitle>
                <div className="flex space-x-1">
                  <Button variant="ghost" size="icon" aria-label="Edit contact name and number" onClick={() => startEditContact(contact)}>
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Delete contact" onClick={() => handleDeleteContact(contact)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {editingId === contact.id && editForm ? (
                  <div className="space-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Contact Name</Label>
                      <Input
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        placeholder="Contact name"
                        className="h-8 text-sm"
                        autoFocus
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Phone Number</Label>
                      <Input
                        value={editForm.phoneNumber}
                        onChange={(e) => setEditForm({ ...editForm, phoneNumber: e.target.value })}
                        placeholder="+639123456789"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Nicknames</Label>
                      <div className="flex flex-wrap gap-2">
                        {contact.nicknames.map((nickname) => (
                          <span
                            key={nickname}
                            className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                          >
                            {nickname}
                            <button
                              onClick={() => removeNickname(contact.id, nickname)}
                              className="ml-1.5 hover:text-destructive"
                              aria-label={`Remove nickname ${nickname}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        {contact.nicknames.length === 0 && (
                          <span className="text-xs text-muted-foreground">No nicknames yet</span>
                        )}
                      </div>
                      <div className="flex space-x-2">
                        <Input
                          value={newNickname}
                          onChange={(e) => setNewNickname(e.target.value)}
                          placeholder="Add nickname"
                          className="h-8 text-sm"
                          onKeyDown={(e) => e.key === 'Enter' && handleAddNickname(contact.id)}
                        />
                        <Button size="sm" onClick={() => handleAddNickname(contact.id)} aria-label="Add nickname">
                          <Check className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveEditContact(contact)}
                        disabled={!editForm.name.trim() || !editForm.phoneNumber.trim()}
                      >
                        <Check className="h-4 w-4 mr-1" />
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={cancelEditContact}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      {contact.phoneNumber}
                    </p>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Nicknames</Label>
                      <div className="flex flex-wrap gap-2">
                        {contact.nicknames.map((nickname) => (
                          <span
                            key={nickname}
                            className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                          >
                            {nickname}
                            <button
                              onClick={() => removeNickname(contact.id, nickname)}
                              className="ml-1.5 hover:text-destructive"
                              aria-label={`Remove nickname ${nickname}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        {contact.nicknames.length === 0 && (
                          <span className="text-xs text-muted-foreground">No nicknames yet</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : contacts.length > 0 ? (
        <p className="flex items-center justify-center gap-2 py-8 text-center text-muted-foreground">
          <Search className="h-4 w-4" />
          No contacts match "{searchTerm}".
        </p>
      ) : (
        <div className="rounded-xl border border-dashed py-12 text-center">
          <Inbox className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
          <h3 className="mb-1 font-semibold">No contacts yet</h3>
          <p className="mx-auto mb-4 max-w-sm text-sm text-muted-foreground">
            Add your first contact — these are the people who'll receive SMS messages for
            their FreeShow assignments.
          </p>
          <Button onClick={() => setIsAdding(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add your first contact
          </Button>
        </div>
      )}
    </div>
  );
}