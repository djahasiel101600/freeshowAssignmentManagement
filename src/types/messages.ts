export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  variables: string[]; // Variable names used in template
}

export interface MessageLog {
  id: string;
  contactId: string;
  contactName: string;
  phoneNumber: string;
  message: string;
  status: 'sent' | 'failed' | 'pending';
  sentAt: string;
  variables: Record<string, string>;
}