import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useToast } from './ui/toast';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../hooks/useServerData';
import { changePassword, fetchSessions } from '../lib/store-api';
import type { AuthSessionRow, AuthUser } from '../types/auth';
import {
  KeyRound, Loader2, LogOut, ShieldCheck, Trash2, UserCog, UserPlus,
} from 'lucide-react';

/**
 * Account & user management.
 *
 * Admins manage accounts here (create, promote, deactivate, delete). Every
 * signed-in user can change their own password and see their active sessions.
 */

export function UsersPanel() {
  const toast = useToast();
  const { user: me, isAdmin, logout } = useAuth();
  const { users, isLoading, create, update, remove } = useUsers(isAdmin);

  // ---- create form ---- //
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'user' });
  const [creating, setCreating] = useState(false);

  // ---- own password ---- //
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [changingPw, setChangingPw] = useState(false);

  // ---- sessions ---- //
  const [sessions, setSessions] = useState<AuthSessionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setSessions(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = async () => {
    if (!form.username.trim() || form.password.length < 8) {
      toast.error('A username and a password of at least 8 characters are required.', {
        title: 'Missing details',
      });
      return;
    }
    setCreating(true);
    try {
      await create({
        username: form.username.trim(),
        displayName: form.displayName.trim() || form.username.trim(),
        password: form.password,
        role: form.role,
      });
      toast.success(`Account “${form.username.trim()}” created.`, { title: 'User created' });
      setForm({ username: '', displayName: '', password: '', role: 'user' });
      setShowForm(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the user.', {
        title: 'Create failed',
      });
    } finally {
      setCreating(false);
    }
  };

  const handlePatch = async (target: AuthUser, payload: Parameters<typeof update>[1]) => {
    try {
      await update(target.id, payload);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed.', { title: 'Update failed' });
    }
  };

  const handleDelete = async (target: AuthUser) => {
    if (!confirm(`Delete the account “${target.username}”? Its sessions are revoked too.`)) return;
    try {
      await remove(target.id);
      toast.success(`Deleted “${target.username}”.`, { title: 'User deleted' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.', { title: 'Delete failed' });
    }
  };

  const handleChangePassword = async () => {
    if (pwNew.length < 8) {
      toast.error('The new password must be at least 8 characters.', { title: 'Password too short' });
      return;
    }
    setChangingPw(true);
    try {
      await changePassword(pwCurrent, pwNew);
      toast.success('Password changed. Other sessions were signed out.', { title: 'Password updated' });
      setPwCurrent('');
      setPwNew('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change the password.', {
        title: 'Change failed',
      });
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Account &amp; Users</h2>
          {me && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              {me.displayName} · {me.role}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button size="sm" onClick={() => setShowForm((open) => !open)}>
              <UserPlus className="h-4 w-4 mr-2" />
              New user
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void logout()}>
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </div>
      {/* ---- admin: account list ---- */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <UserCog className="h-5 w-5" />
              Accounts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {showForm && (
              <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="new-username">Username</Label>
                  <Input
                    id="new-username"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="maryj"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-display">Display name</Label>
                  <Input
                    id="new-display"
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    placeholder="Mary J."
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-password">Password (min 8)</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-role">Role</Label>
                  <select
                    id="new-role"
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </div>
                <div className="sm:col-span-4">
                  <Button size="sm" onClick={handleCreate} disabled={creating}>
                    {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                    Create account
                  </Button>
                </div>
              </div>
            )}
            {isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">User</th>
                      <th className="py-2 pr-3 font-medium">Role</th>
                      <th className="py-2 pr-3 font-medium">Active</th>
                      <th className="py-2 pr-3 font-medium">Last login</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <span className="font-medium">{u.displayName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">@{u.username}</span>
                        </td>
                        <td className="py-2 pr-3">
                          <select
                            aria-label={`Role for ${u.username}`}
                            className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
                            value={u.role}
                            onChange={(e) => void handlePatch(u, { role: e.target.value })}
                          >
                            <option value="user">user</option>
                            <option value="admin">admin</option>
                          </select>
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            aria-label={`Active for ${u.username}`}
                            checked={u.isActive}
                            onChange={(e) => void handlePatch(u, { isActive: e.target.checked })}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              const password = prompt(`New password for ${u.username} (min 8 chars):`);
                              if (password) void handlePatch(u, { password });
                            }}
                          >
                            <KeyRound className="h-4 w-4" />
                          </Button>
                          {me?.id !== u.id && (
                            <Button variant="ghost" size="sm" onClick={() => void handleDelete(u)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </CardContent>
        </Card>
      )}

      {/* ---- self service: password ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Change my password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pw-current">Current password</Label>
              <Input
                id="pw-current"
                type="password"
                value={pwCurrent}
                autoComplete="current-password"
                onChange={(e) => setPwCurrent(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pw-new">New password (min 8)</Label>
              <Input
                id="pw-new"
                type="password"
                value={pwNew}
                autoComplete="new-password"
                onChange={(e) => setPwNew(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handleChangePassword} disabled={changingPw}>
            {changingPw ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
            Update password
          </Button>
        </CardContent>
      </Card>

      {/* ---- self service: sessions ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Active sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions === null ? (
            <p className="text-sm text-muted-foreground">Session details are not available.</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{s.username}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.userAgent || 'unknown device'}</p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    last seen {new Date(s.lastSeenAt).toLocaleString()} · expires{' '}
                    {new Date(s.expiresAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
