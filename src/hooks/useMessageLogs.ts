import { useState } from 'react';
import type { MessageLog } from '../types/messages';

const STORAGE_KEY = 'freeshow-message-logs';

export function useMessageLogs() {
  const [logs, setLogs] = useState<MessageLog[]>(() => {
    try {
      const storedLogs = localStorage.getItem(STORAGE_KEY);
      if (!storedLogs) return [];
      const parsed = JSON.parse(storedLogs);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error parsing message logs:', error);
      return [];
    }
  });

  const addLog = (log: Omit<MessageLog, 'id'>) => {
    addLogs([log]);
  };

  const addLogs = (newLogs: Omit<MessageLog, 'id'>[]) => {
    if (newLogs.length === 0) return;
    // Give each log a unique id (timestamp + random suffix) to avoid collisions.
    const logsToAdd: MessageLog[] = newLogs.map((log) => ({
      ...log,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }));
    // Newest first (reverse so the last log in the batch appears on top).
    const updatedLogs = [...logsToAdd.reverse(), ...logs];
    setLogs(updatedLogs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedLogs));
  };

  const clearLogs = () => {
    setLogs([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  return {
    logs,
    addLog,
    addLogs,
    clearLogs,
  };
}