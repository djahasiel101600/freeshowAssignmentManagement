import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as store from '../lib/store-api';
import type { Contact } from '../types/contacts';

const QUERY_KEY = ['contacts'];

/**
 * Contacts live in the receiver's database now (previously localStorage), so a
 * contact list survives a browser reset and is shared by everyone who signs in.
 * The returned shape is unchanged, which is why ContactsManager needed no edit.
 */
export function useContacts() {
  const queryClient = useQueryClient();

  const contactsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: store.fetchContacts,
    staleTime: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const addContactMutation = useMutation({
    mutationFn: (contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>) =>
      store.createContact(contact),
    onSuccess: invalidate,
  });

  const updateContactMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<Contact> }) =>
      store.updateContact(id, updates),
    onSuccess: invalidate,
  });

  const deleteContactMutation = useMutation({
    mutationFn: (id: string) => store.deleteContact(id),
    onSuccess: invalidate,
  });

  const addNicknameMutation = useMutation({
    mutationFn: ({ contactId, nickname }: { contactId: string; nickname: string }) =>
      store.addNickname(contactId, nickname),
    onSuccess: invalidate,
  });

  const removeNicknameMutation = useMutation({
    mutationFn: ({ contactId, nickname }: { contactId: string; nickname: string }) =>
      store.removeNickname(contactId, nickname),
    onSuccess: invalidate,
  });

  return {
    contacts: contactsQuery.data ?? [],
    isLoading: contactsQuery.isLoading,
    error: contactsQuery.error,
    refetch: contactsQuery.refetch,
    addContact: addContactMutation.mutate,
    updateContact: (id: string, updates: Partial<Contact>) =>
      updateContactMutation.mutate({ id, updates }),
    deleteContact: deleteContactMutation.mutate,
    addNickname: (contactId: string, nickname: string) =>
      addNicknameMutation.mutate({ contactId, nickname }),
    removeNickname: (contactId: string, nickname: string) =>
      removeNicknameMutation.mutate({ contactId, nickname }),
  };
}
