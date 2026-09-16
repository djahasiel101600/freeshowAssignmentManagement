import axios, { type AxiosInstance } from 'axios';

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  secret?: string;
  headers?: Record<string, string>;
  retryCount?: number;
  retryDelay?: number;
  includeAllVariables?: boolean;
  batchUpdates?: boolean;
  batchWindow?: number;
  // New: Use proxy or direct URL
  useProxy?: boolean;
}

export interface WebhookPayload {
  event: 'variable_changed' | 'variables_updated' | 'test' | 'batch_update' | 'manual_trigger';
  timestamp: string;
  source: string;
  data: {
    variables?: any[];
    changed?: any;
    updates?: Array<{ id: string; name: string; value: string }>;
    count?: number;
  };
  metadata?: {
    totalVariables?: number;
    triggerType?: 'single' | 'bulk' | 'batch' | 'test' | 'manual';
    batchSize?: number;
  };
}

export interface WebhookTestResult {
  success: boolean;
  message: string;
  statusCode?: number;
  statusText?: string;
  details?: string;
}

class WebhookAPI {
  private client: AxiosInstance;
  private config: WebhookConfig | null = null;
  private batchQueue: Array<{ id: string; name: string; value: string; timestamp: string }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPromise: Promise<boolean> | null = null;
  private lastError: string | null = null;

  constructor() {
    this.client = axios.create({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    });

    // Load config from localStorage
    this.loadConfig();
  }

  private loadConfig() {
    try {
      const saved = localStorage.getItem('webhook_config');
      if (saved) {
        this.config = JSON.parse(saved);
        if (this.config) {
          this.config.includeAllVariables = this.config.includeAllVariables !== undefined ? this.config.includeAllVariables : true;
          this.config.batchUpdates = this.config.batchUpdates !== undefined ? this.config.batchUpdates : false;
          this.config.batchWindow = this.config.batchWindow || 2000;
          this.config.useProxy = this.config.useProxy !== undefined ? this.config.useProxy : true; // Default to using proxy
        }
      }
    } catch (error) {
      console.error('Error loading webhook config:', error);
    }
  }

  setConfig(config: WebhookConfig) {
    config.includeAllVariables = config.includeAllVariables !== undefined ? config.includeAllVariables : true;
    config.batchUpdates = config.batchUpdates !== undefined ? config.batchUpdates : false;
    config.batchWindow = config.batchWindow || 2000;
    config.useProxy = config.useProxy !== undefined ? config.useProxy : true;
    
    this.config = config;
    localStorage.setItem('webhook_config', JSON.stringify(config));
    this.lastError = null;
  }

  getConfig(): WebhookConfig | null {
    return this.config;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private getWebhookUrl(): string {
    if (!this.config) return '';
    
    // If using proxy, use the /webhook endpoint
    if (this.config.useProxy) {
      return '/webhook';
    }
    
    // Otherwise use the direct URL
    return this.config.url;
  }

  private async sendToN8N(payload: WebhookPayload, retryCount?: number): Promise<boolean> {
    if (!this.config || !this.config.enabled) {
      this.lastError = 'Webhook not configured or disabled';
      console.log(this.lastError);
      return false;
    }

    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) {
      this.lastError = 'Webhook URL not configured';
      console.log(this.lastError);
      return false;
    }

    const maxRetries = retryCount ?? this.config.retryCount ?? 3;
    const retryDelay = this.config.retryDelay ?? 1000;

    // Add headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Source': 'ChurchManagementApp',
      'X-Event-Type': payload.event,
      ...this.config.headers,
    };

    if (this.config.secret) {
      headers['X-Webhook-Secret'] = this.config.secret;
      headers['Authorization'] = `Bearer ${this.config.secret}`;
    }

    // Log the request
    console.log(`Sending webhook to: ${webhookUrl} (using ${this.config.useProxy ? 'proxy' : 'direct'} connection)`);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.post(webhookUrl, payload, { headers });

        console.log(`Webhook response status: ${response.status} ${response.statusText}`);
        console.log('Response data:', response.data);

        if (response.status >= 200 && response.status < 300) {
          this.lastError = null;
          console.log(`Webhook sent successfully (attempt ${attempt})`);
          return true;
        } else if (response.status === 404) {
          this.lastError = `Webhook endpoint not found (404). Please check your n8n webhook URL.`;
          console.error(this.lastError);
          return false;
        } else if (response.status >= 400 && response.status < 500) {
          this.lastError = `Client error: ${response.status} ${response.statusText}`;
          console.error(this.lastError);
          return false;
        } else if (response.status >= 500) {
          this.lastError = `Server error: ${response.status} ${response.statusText}`;
          console.error(this.lastError);
          
          if (attempt < maxRetries) {
            console.log(`Retrying in ${retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
          return false;
        }
      } catch (error: any) {
        console.error(`Webhook attempt ${attempt} failed:`, error);
        
        // Detailed error handling
        if (error.code === 'ECONNREFUSED') {
          this.lastError = 'Cannot connect to webhook. Is n8n running and accessible?';
          console.error(this.lastError);
          return false;
        } else if (error.response) {
          const statusCode = error.response.status;
          const statusText = error.response.statusText || 'Unknown error';
          
          if (statusCode === 404) {
            this.lastError = `Webhook endpoint not found (404). Please verify your n8n webhook URL.`;
          } else if (statusCode === 401 || statusCode === 403) {
            this.lastError = `Authentication failed (${statusCode}). Check your webhook secret.`;
          } else {
            this.lastError = `Server responded with ${statusCode}: ${statusText}`;
          }
          
          console.error('Response error:', {
            status: statusCode,
            statusText: statusText,
            data: error.response.data
          });
          
          if (attempt < maxRetries && statusCode >= 500) {
            console.log(`Retrying in ${retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
          return false;
        } else if (error.request) {
          this.lastError = 'No response received from webhook server. Check network connectivity.';
          console.error(this.lastError);
          return false;
        } else {
          this.lastError = `Request error: ${error.message}`;
          console.error(this.lastError);
          return false;
        }
      }
    }

    this.lastError = `All ${maxRetries} webhook attempts failed`;
    console.error(this.lastError);
    return false;
  }

  async sendVariableUpdate(variables: any[], changedVariable?: any): Promise<boolean> {
    if (!this.config || !this.config.enabled) {
      this.lastError = 'Webhook not enabled';
      return false;
    }

    if (this.config.batchUpdates && changedVariable) {
      return this.addToBatch(variables, changedVariable);
    }

    const payload: WebhookPayload = {
      event: changedVariable ? 'variable_changed' : 'variables_updated',
      timestamp: new Date().toISOString(),
      source: 'ChurchManagementApp',
      data: {
        variables: this.config.includeAllVariables ? variables : [],
        changed: changedVariable || null,
        count: variables.length,
        updates: changedVariable ? [{
          id: changedVariable.id,
          name: changedVariable.name,
          value: changedVariable.value
        }] : undefined
      },
      metadata: {
        totalVariables: variables.length,
        triggerType: changedVariable ? 'single' : 'bulk'
      }
    };

    return this.sendToN8N(payload);
  }

  private async addToBatch(variables: any[], changedVariable: any): Promise<boolean> {
    this.batchQueue.push({
      id: changedVariable.id,
      name: changedVariable.name,
      value: changedVariable.value,
      timestamp: new Date().toISOString()
    });

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.pendingPromise = new Promise((resolve) => {
      this.batchTimer = setTimeout(async () => {
        const batchItems = [...this.batchQueue];
        this.batchQueue = [];
        this.batchTimer = null;
        this.pendingPromise = null;

        if (batchItems.length === 0) {
          resolve(false);
          return;
        }

        const payload: WebhookPayload = {
          event: 'batch_update',
          timestamp: new Date().toISOString(),
          source: 'ChurchManagementApp',
          data: {
            variables: this.config?.includeAllVariables ? variables : [],
            updates: batchItems,
            count: batchItems.length
          },
          metadata: {
            totalVariables: variables.length,
            triggerType: 'batch',
            batchSize: batchItems.length
          }
        };

        const success = await this.sendToN8N(payload);
        resolve(success);
      }, this.config?.batchWindow || 2000);
    });

    return this.pendingPromise;
  }

  async testConnection(): Promise<WebhookTestResult> {
    if (!this.config) {
      return { 
        success: false, 
        message: 'Webhook not configured',
        details: 'Please configure webhook settings first'
      };
    }

    if (!this.config.enabled) {
      return {
        success: false,
        message: 'Webhook is disabled',
        details: 'Please enable webhook in settings'
      };
    }

    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) {
      return {
        success: false,
        message: 'Webhook URL not configured',
        details: 'Please set a webhook URL in settings'
      };
    }

    const payload: WebhookPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      source: 'ChurchManagementApp',
      data: {
        variables: [],
        count: 0
      },
      metadata: {
        totalVariables: 0,
        triggerType: 'test'
      }
    };

    try {
      console.log(`Testing webhook connection via ${this.config.useProxy ? 'proxy' : 'direct'} to: ${webhookUrl}`);
      
      const success = await this.sendToN8N(payload, 1);
      
      if (success) {
        return { 
          success: true, 
          message: 'Successfully connected to n8n webhook',
          details: this.config.useProxy ? 'Using Vite proxy (CORS bypassed)' : 'Direct connection'
        };
      } else {
        return {
          success: false,
          message: 'Failed to connect to webhook',
          details: this.lastError || 'Unknown error occurred'
        };
      }
    } catch (error: any) {
      return {
        success: false,
        message: 'Error testing webhook',
        details: error.message || 'Unknown error occurred'
      };
    }
  }

  async triggerManualUpdate(variables: any[]): Promise<boolean> {
    if (!this.config || !this.config.enabled) {
      this.lastError = 'Webhook not enabled';
      console.log(this.lastError);
      return false;
    }

    const payload: WebhookPayload = {
      event: 'manual_trigger',
      timestamp: new Date().toISOString(),
      source: 'ChurchManagementApp',
      data: {
        variables: variables,
        count: variables.length
      },
      metadata: {
        totalVariables: variables.length,
        triggerType: 'manual'
      }
    };

    return this.sendToN8N(payload);
  }

  clearConfig() {
    this.config = null;
    this.lastError = null;
    localStorage.removeItem('webhook_config');
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchQueue = [];
    this.pendingPromise = null;
  }
}

export const webhookAPI = new WebhookAPI();