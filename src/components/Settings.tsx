import { useState, useEffect } from 'react';
import { semaphoreAPI } from '../lib/semaphore-api';
import { webhookAPI, type WebhookConfig } from '../lib/webhook-api';
import { serverApi, type ServerHealth } from '../lib/server-api';
import { useAppSettings } from '../hooks/useServerData';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Save, Webhook, Send, Check, AlertCircle, Zap, Server, Activity } from 'lucide-react';
import { Switch } from './ui/switch';
import { useToast } from './ui/toast';
import { DataManager } from './DataManager';

const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  url: '',
  enabled: false,
  retryCount: 3,
  retryDelay: 1000,
  includeAllVariables: true,
  batchUpdates: false,
  batchWindow: 2000,
};

export function Settings() {
  const toast = useToast();
  // Semaphore + webhook settings live in the receiver's database now; these
  // are local drafts until "Save" is pressed.
  const { settings, save } = useAppSettings();

  const [semaphoreConfig, setSemaphoreConfig] = useState({
    apiKey: '',
    senderName: 'ChurchName',
  });

  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>(DEFAULT_WEBHOOK_CONFIG);
  const [integrationsLoaded, setIntegrationsLoaded] = useState(false);

  // Pull the saved values into the editable drafts once (and only once).
  useEffect(() => {
    if (!settings || integrationsLoaded) return;
    setIntegrationsLoaded(true);
    const semaphore = settings.semaphore as { apiKey?: string; senderName?: string } | undefined;
    if (semaphore) {
      setSemaphoreConfig({
        apiKey: semaphore.apiKey ?? '',
        senderName: semaphore.senderName ?? 'ChurchName',
      });
    }
    const webhook = settings.webhook as Partial<WebhookConfig> | undefined;
    setWebhookConfig({ ...DEFAULT_WEBHOOK_CONFIG, ...(webhook ?? {}) });
    // Note: the semaphore/webhook *clients* are activated in useAppSettings so
    // they work even if this panel is never opened. Here we only fill drafts.
  }, [settings, integrationsLoaded]);

  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'connected' | 'disconnected' | 'idle'>('idle');
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  // Timestamp of the last health poll. Held in state (instead of reading
  // Date.now() during render) so rendering remains pure.
  const [nowMs, setNowMs] = useState(0);
  const [appToken, setAppToken] = useState<string>(() => serverApi.getAppToken());
  const [webhookStatus, setWebhookStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [webhookMessage, setWebhookMessage] = useState<string>('');
  const [semaphoreStatus, setSemaphoreStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [semaphoreMessage, setSemaphoreMessage] = useState<string>('');

  // Poll the receiver's health endpoint so the connection status stays live.
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const health = await serverApi.getServerHealth();
        if (!cancelled) {
          setServerHealth(health);
          setConnectionStatus(health.ok ? 'connected' : 'disconnected');
          setNowMs(Date.now());
        }
      } catch {
        if (!cancelled) {
          setServerHealth(null);
          setConnectionStatus('disconnected');
          setNowMs(Date.now());
        }
      }
    };

    check();
    const timer = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const formatLastSync = (iso: string | null, now: number): string => {
    if (!iso) return 'No sync yet';
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) return 'Unknown';
    if (!now) return 'unknown';
    const secs = Math.max(0, Math.round((now - time) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  };

  const testServerConnection = async () => {
    setConnectionStatus('testing');
    try {
      const health = await serverApi.getServerHealth();
      setServerHealth(health);
      setConnectionStatus('connected');
      toast.success(
        `Receiver online — ${health.variableCount} variable(s), last sync ${formatLastSync(
          health.lastSyncAt,
          Date.now()
        )}.`,
        { title: 'Server reachable' }
      );
    } catch (error) {
      setConnectionStatus('disconnected');
      const message =
        error instanceof Error ? error.message : 'Could not reach the receiver server.';
      toast.error(message, { title: 'Server unreachable', duration: 10000 });
    }
    setTimeout(() => setConnectionStatus('idle'), 5000);
  };

  const testWebhook = async () => {
    if (!webhookConfig.url) {
      setWebhookMessage('Please enter a webhook URL');
      setWebhookStatus('error');
      setTimeout(() => setWebhookStatus('idle'), 3000);
      return;
    }

    setWebhookStatus('testing');
    setWebhookMessage('Testing webhook...');
    
    try {
      const result = await webhookAPI.testConnection();
      if (result.success) {
        setWebhookStatus('success');
        setWebhookMessage(result.message);
        toast.success('n8n webhook responded successfully', { title: 'Webhook connected' });
      } else {
        setWebhookStatus('error');
        setWebhookMessage(result.message);
        toast.error(result.message || 'Webhook test failed', { title: 'Webhook failed' });
      }
    } catch {
      setWebhookStatus('error');
      setWebhookMessage('Error testing webhook');
      toast.error('Something went wrong while testing the webhook', { title: 'Webhook failed' });
    }
    
    setTimeout(() => {
      setWebhookStatus('idle');
      setWebhookMessage('');
    }, 5000);
  };

  const saveBridgeSettings = () => {
    serverApi.setAppToken(appToken);
    toast.success(
      appToken.trim()
        ? 'App token saved. Server requests will include it.'
        : 'App token cleared. Server requests will be sent without an app token.',
      {
        title: 'Settings saved',
        duration: 6000,
      }
    );
  };

  const saveSemaphoreSettings = async () => {
    semaphoreAPI.setConfig(semaphoreConfig);
    try {
      await save('semaphore', semaphoreConfig);
      toast.success('Semaphore SMS settings saved to the server.', { title: 'Settings saved' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the settings.', {
        title: 'Save failed',
        duration: 8000,
      });
    }
  };

  const testSemaphoreConnection = async () => {
    if (!semaphoreConfig.apiKey.trim()) {
      setSemaphoreMessage('Enter your Semaphore API key first.');
      setSemaphoreStatus('error');
      return;
    }
    setSemaphoreStatus('testing');
    setSemaphoreMessage('Testing connection...');
    semaphoreAPI.setConfig(semaphoreConfig);
    try {
      const result = await semaphoreAPI.getAccountInfo();
      if (result.status === 'success') {
        setSemaphoreStatus('success');
        setSemaphoreMessage('Connected to Semaphore! Your API key is valid.');
        toast.success('Semaphore API key is valid.', { title: 'Connection successful' });
      } else {
        setSemaphoreStatus('error');
        const detail =
          result.message && result.message !== 'Failed to get account information'
            ? result.message
            : 'The API key may be wrong or the account is unavailable. Check your key and try again.';
        setSemaphoreMessage(detail);
        toast.error(detail, { title: 'Connection failed', duration: 10000 });
      }
    } catch {
      setSemaphoreStatus('error');
      const detail = 'Could not reach Semaphore. Check the API key and your network connection.';
      setSemaphoreMessage(detail);
      toast.error(detail, { title: 'Connection failed', duration: 10000 });
    }
    setTimeout(() => setSemaphoreStatus('idle'), 8000);
  };

  const saveWebhookSettings = async () => {
    webhookAPI.setConfig(webhookConfig);
    try {
      await save('webhook', webhookConfig);
      toast.success('Webhook settings saved to the server.', { title: 'Settings saved' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the settings.', {
        title: 'Save failed',
        duration: 8000,
      });
    }
  };

  const handleWebhookToggle = (enabled: boolean) => {
    setWebhookConfig({ ...webhookConfig, enabled });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Server className="h-4 w-4" />
              Bridge &amp; Server
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                FreeShow variables are delivered by the receiver server, which the Python bridge
                keeps up to date from the machine running FreeShow. Variable edits made here are
                queued as commands and applied by that bridge.
              </p>
            </div>

            <div className="flex items-center space-x-2 text-sm">
              {connectionStatus === 'connected' ? (
                <>
                  <Activity className="h-4 w-4 text-green-500" />
                  <span className="text-green-600">Receiver online</span>
                </>
              ) : connectionStatus === 'testing' ? (
                <>
                  <Activity className="h-4 w-4 text-yellow-500 animate-pulse" />
                  <span className="text-yellow-600">Checking server...</span>
                </>
              ) : connectionStatus === 'disconnected' ? (
                <>
                  <AlertCircle className="h-4 w-4 text-red-500" />
                  <span className="text-red-600">
                    Cannot reach the receiver server. Check the deployment and the app token.
                  </span>
                </>
              ) : (
                <>
                  <Activity className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-600">Connection status unknown</span>
                </>
              )}
            </div>

            {serverHealth && (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Variables</p>
                  <p className="font-semibold">{serverHealth.variableCount}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Last sync</p>
                  <p className="font-semibold">{formatLastSync(serverHealth.lastSyncAt, nowMs)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Pending commands</p>
                  <p className="font-semibold">{serverHealth.pendingCommands}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Source</p>
                  <p className="font-semibold truncate" title={serverHealth.source || '—'}>
                    {serverHealth.source || '—'}
                  </p>
                </div>
              </div>
            )}

            <div>
              <Label htmlFor="app-token">App Token</Label>
              <Input
                id="app-token"
                type="password"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="Only needed if APP_TOKEN is set on the server"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Stored in this browser only and sent as <code>X-App-Token</code> with server
                requests, including SMS sends.
              </p>
            </div>

            <Button
              variant="outline"
              onClick={testServerConnection}
              disabled={connectionStatus === 'testing'}
              className="w-full"
            >
              {connectionStatus === 'testing' ? 'Checking...' : 'Test Server Connection'}
            </Button>
          </CardContent>
          <CardFooter>
            <Button onClick={saveBridgeSettings}>
              <Save className="h-4 w-4 mr-2" />
              Save Settings
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Semaphore SMS Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">
                <strong>Required:</strong> You need a Semaphore API key to send SMS messages. 
                Get one from{' '}
                <a 
                  href="https://semaphore.co" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-yellow-600 hover:text-yellow-800 underline"
                >
                  semaphore.co
                </a>
              </p>
            </div>

            <div>
              <Label htmlFor="semaphore-key">API Key *</Label>
              <Input
                id="semaphore-key"
                type="password"
                value={semaphoreConfig.apiKey}
                onChange={(e) => setSemaphoreConfig({ ...semaphoreConfig, apiKey: e.target.value })}
                placeholder="Your Semaphore API key"
              />
            </div>
            <div>
              <Label htmlFor="sender-name">Sender Name</Label>
              <Input
                id="sender-name"
                value={semaphoreConfig.senderName}
                onChange={(e) => setSemaphoreConfig({ ...semaphoreConfig, senderName: e.target.value })}
                placeholder="ChurchName"
                maxLength={11}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Maximum 11 characters. Must match a name you've registered with Semaphore.
              </p>
            </div>

            {semaphoreStatus !== 'idle' && semaphoreMessage && (
              <div
                className={`flex items-start gap-2 rounded-lg p-3 text-sm ${
                  semaphoreStatus === 'testing'
                    ? 'bg-blue-50 text-blue-800'
                    : semaphoreStatus === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {semaphoreStatus === 'success' ? (
                  <Check className="h-4 w-4 mt-0.5" />
                ) : semaphoreStatus === 'error' ? (
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                ) : (
                  <Zap className="h-4 w-4 mt-0.5" />
                )}
                <p className="break-words">{semaphoreMessage}</p>
              </div>
            )}
          </CardContent>
          <CardFooter className="space-x-2">
            <Button onClick={saveSemaphoreSettings}>
              <Save className="h-4 w-4 mr-2" />
              Save Settings
            </Button>
            <Button
              variant="outline"
              onClick={testSemaphoreConnection}
              disabled={semaphoreStatus === 'testing'}
            >
              <Zap className="h-4 w-4 mr-2" />
              {semaphoreStatus === 'testing' ? 'Testing...' : 'Test Connection'}
            </Button>
          </CardFooter>
        </Card>
      </div>

      {/* Webhook Configuration Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            <span className="flex items-center">
              <Webhook className="h-5 w-5 mr-2" />
              n8n Webhook Integration
            </span>
            <div className="flex items-center space-x-2">
              <Label htmlFor="webhook-enabled" className="text-sm font-normal">
                {webhookConfig.enabled ? 'Enabled' : 'Disabled'}
              </Label>
              <Switch
                id="webhook-enabled"
                checked={webhookConfig.enabled}
                onCheckedChange={handleWebhookToggle}
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
            <p className="text-sm text-purple-800">
              <strong>n8n Integration:</strong> When enabled, all variable changes in FreeShow 
              will be automatically sent to your n8n webhook endpoint.
            </p>
          </div>

          <div>
            <Label htmlFor="webhook-url">Webhook URL Path</Label>
            <Input
              id="webhook-url"
              value={webhookConfig.url}
              onChange={(e) => setWebhookConfig({ ...webhookConfig, url: e.target.value })}
              placeholder="/webhook-test/your-webhook-id"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Enter the webhook path (e.g., /webhook-test/your-webhook-id). 
              The proxy will handle the full URL: https://n8n.jdp-homelab.space
            </p>
            <div className="mt-1 text-xs bg-blue-50 p-2 rounded">
              <strong>Current proxy target:</strong> https://n8n.jdp-homelab.space
            </div>
          </div>

          <div>
            <Label htmlFor="webhook-secret">Secret (Optional)</Label>
            <Input
              id="webhook-secret"
              type="password"
              value={webhookConfig.secret || ''}
              onChange={(e) => setWebhookConfig({ ...webhookConfig, secret: e.target.value || undefined })}
              placeholder="Optional secret for webhook authentication"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Will be sent as both X-Webhook-Secret and Bearer token for compatibility
            </p>
          </div>

          <div className="border-t pt-4">
            <h4 className="text-sm font-semibold mb-3">Advanced n8n Options</h4>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="include-all" className="text-sm">Include All Variables</Label>
                  <p className="text-xs text-muted-foreground">Send all variables in every webhook payload</p>
                </div>
                <Switch
                  id="include-all"
                  checked={webhookConfig.includeAllVariables}
                  onCheckedChange={(checked) => setWebhookConfig({ ...webhookConfig, includeAllVariables: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="batch-updates" className="text-sm flex items-center">
                    <Zap className="h-3 w-3 mr-1" />
                    Batch Updates
                  </Label>
                  <p className="text-xs text-muted-foreground">Group multiple updates into single webhook</p>
                </div>
                <Switch
                  id="batch-updates"
                  checked={webhookConfig.batchUpdates}
                  onCheckedChange={(checked) => setWebhookConfig({ ...webhookConfig, batchUpdates: checked })}
                />
              </div>

              {webhookConfig.batchUpdates && (
                <div>
                  <Label htmlFor="batch-window">Batch Window (ms)</Label>
                  <Input
                    id="batch-window"
                    type="number"
                    min="500"
                    step="500"
                    value={webhookConfig.batchWindow || 2000}
                    onChange={(e) => setWebhookConfig({ ...webhookConfig, batchWindow: parseInt(e.target.value) || 2000 })}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Time window to collect updates before sending as batch
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="text-sm font-semibold mb-3">Retry Settings</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="retry-count">Retry Count</Label>
                <Input
                  id="retry-count"
                  type="number"
                  min="1"
                  max="10"
                  value={webhookConfig.retryCount || 3}
                  onChange={(e) => setWebhookConfig({ ...webhookConfig, retryCount: parseInt(e.target.value) || 3 })}
                />
              </div>
              <div>
                <Label htmlFor="retry-delay">Retry Delay (ms)</Label>
                <Input
                  id="retry-delay"
                  type="number"
                  min="500"
                  step="500"
                  value={webhookConfig.retryDelay || 1000}
                  onChange={(e) => setWebhookConfig({ ...webhookConfig, retryDelay: parseInt(e.target.value) || 1000 })}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {webhookStatus === 'success' && (
              <div className="flex items-center text-green-600">
                <Check className="h-4 w-4 mr-1" />
                <span className="text-sm">{webhookMessage}</span>
              </div>
            )}
            {webhookStatus === 'error' && (
              <div className="flex items-center text-red-600">
                <AlertCircle className="h-4 w-4 mr-1" />
                <span className="text-sm">{webhookMessage}</span>
              </div>
            )}
            {webhookStatus === 'testing' && (
              <div className="flex items-center text-yellow-600">
                <span className="text-sm">Testing webhook...</span>
              </div>
            )}
          </div>

          <div className="flex space-x-2">
            <Button 
              variant="outline" 
              onClick={testWebhook}
              disabled={webhookStatus === 'testing' || !webhookConfig.url}
              className="flex-1"
            >
              <Send className="h-4 w-4 mr-2" />
              Test n8n Webhook
            </Button>
          </div>

          <div className="bg-gray-50 p-3 rounded-lg">
            <h4 className="text-sm font-semibold mb-2">Payload Format for n8n:</h4>
            <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
{`{
  "event": "variable_changed" | "variables_updated" | "batch_update" | "test",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "source": "ChurchManagementApp",
  "data": {
    "variables": [...], // All current variables (if includeAll is true)
    "changed": { // Only for single changes
      "id": "var_123",
      "name": "Song Title",
      "value": "Amazing Grace"
    },
    "updates": [...], // For batch updates
    "count": 5
  },
  "metadata": {
    "totalVariables": 10,
    "triggerType": "single" | "bulk" | "batch" | "test"
  }
}`}
            </pre>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>n8n Webhook Node Settings:</strong> Use "Webhook" node with method POST, 
              JSON body, and optional authentication headers.
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={saveWebhookSettings} className="w-full">
            <Webhook className="h-4 w-4 mr-2" />
            Save n8n Webhook Settings
          </Button>
        </CardFooter>
      </Card>

      <DataManager />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Setup Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="space-y-1">
            <h4 className="font-semibold">1. Receiver server</h4>
            <p className="text-muted-foreground">
              Run the FastAPI receiver on the machine that serves this app. It stores the latest
              variable snapshot, queues variable edits, proxies Semaphore SMS, and serves this
              frontend. Start it with <code className="bg-muted px-1 rounded">uvicorn app:app</code>{' '}
              (see <code className="bg-muted px-1 rounded">DEPLOYMENT.md</code>).
            </p>
          </div>
          <div className="space-y-1">
            <h4 className="font-semibold">2. FreeShow bridge</h4>
            <p className="text-muted-foreground">
              Run the Python bridge on the machine that has FreeShow. It listens to FreeShow's
              variable changes and POSTs snapshots to the receiver, and applies any queued variable
              edits back into FreeShow.
            </p>
          </div>
          <div className="space-y-1">
            <h4 className="font-semibold">3. App token</h4>
            <p className="text-muted-foreground">
              If the receiver runs with an app token enabled, paste it above so this browser can
              read variables, queue edits, and send SMS.
            </p>
          </div>
          <div className="space-y-1">
            <h4 className="font-semibold">4. Configure Semaphore</h4>
            <p className="text-muted-foreground">
              Enter your Semaphore API key and sender name to enable SMS sending. Sends are proxied
              through the receiver server.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
