import { useState } from 'react';
import type { Contact } from '../types/contacts';

const STORAGE_KEY = 'freeshow-contacts';

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>(() => {
    try {
      const storedContacts = localStorage.getItem(STORAGE_KEY);
      if (!storedContacts) return [];
      const parsed = JSON.parse(storedContacts);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error parsing contacts from localStorage:', error);
      return [];
    }
  });

  const saveContacts = (newContacts: Contact[]) => {
    setContacts(newContacts);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newContacts));
  };

  const addContact = (contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newContact: Contact = {
      ...contact,
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveContacts([...contacts, newContact]);
    return newContact;
  };

  const updateContact = (id: string, updates: Partial<Contact>) => {
    const updatedContacts = contacts.map(contact =>
      contact.id === id
        ? { ...contact, ...updates, updatedAt: new Date().toISOString() }
        : contact
    );
    saveContacts(updatedContacts);
  };

  const deleteContact = (id: string) => {
    saveContacts(contacts.filter(contact => contact.id !== id));
  };

  const addNickname = (contactId: string, nickname: string) => {
    const contact = contacts.find(c => c.id === contactId);
    if (contact && !contact.nicknames.includes(nickname)) {
      updateContact(contactId, {
        nicknames: [...contact.nicknames, nickname]
      });
    }
  };

  const removeNickname = (contactId: string, nickname: string) => {
    const contact = contacts.find(c => c.id === contactId);
    if (contact) {
      updateContact(contactId, {
        nicknames: contact.nicknames.filter(n => n !== nickname)
      });
    }
  };

  return {
    contacts,
    isLoading: false,
    addContact,
    updateContact,
    deleteContact,
    addNickname,
    removeNickname,
  };
}