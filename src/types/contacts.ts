export interface Contact {
  id: string;
  name: string;
  phoneNumber: string;
  nicknames: string[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactGroup {
  id: string;
  name: string;
  contacts: string[]; // Contact IDs
}