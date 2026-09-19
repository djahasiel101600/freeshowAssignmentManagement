export type UserRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AuthSessionRow {
  id: string;
  username: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string;
}

export interface BootstrapState {
  ok: boolean;
  hasUsers: boolean;
  requiresLogin: boolean;
}