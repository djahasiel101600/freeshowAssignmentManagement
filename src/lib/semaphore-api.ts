import axios, { type AxiosInstance } from 'axios';
import { getAppToken } from './server-api';

export interface SemaphoreConfig {
  apiKey: string;
  senderName: string;
}

export interface SemaphoreResponse {
  status: 'success' | 'error';
  message: string;
  data?: any;
  message_id?: string;
  code?: string;
}

class SemaphoreAPI {
  private client: AxiosInstance;
  private config: SemaphoreConfig = {
    apiKey: '',
    senderName: 'Church'
  };

  constructor() {
    this.client = axios.create({
      baseURL: '/semaphore',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // The receiver proxies /semaphore and may gate it behind X-App-Token.
    this.client.interceptors.request.use((config) => {
      const token = getAppToken();
      if (token) {
        config.headers = config.headers ?? {};
        (config.headers as Record<string, string>)['X-App-Token'] = token;
      }
      return config;
    });
  }

  setConfig(config: Partial<SemaphoreConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SemaphoreConfig {
    return { ...this.config };
  }

  async sendMessage(phoneNumber: string, message: string): Promise<SemaphoreResponse> {
    try {
      // Format phone number (remove spaces, ensure proper format)
      const formattedNumber = phoneNumber.replace(/\s+/g, '').replace(/^0/, '+63');
      
      const formData = new URLSearchParams();
      formData.append('apikey', this.config.apiKey);
      formData.append('number', formattedNumber);
      formData.append('message', message);
      formData.append('sendername', this.config.senderName);

      const response = await this.client.post('/messages', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      console.log('Semaphore response:', response.data);

      if (response.data && Array.isArray(response.data) && response.data[0]?.status === 'error') {
        return {
          status: 'error',
          message: response.data[0]?.message || 'Semaphore rejected the message',
          data: response.data,
          code: response.data[0]?.code,
        };
      }

      return {
        status: 'success',
        message: 'Message sent successfully',
        data: response.data,
        message_id: response.data?.[0]?.message_id,
      };
    } catch (error: any) {
      const httpStatus = error.response?.status;
      const serverMessage =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.response?.data?.[0]?.message ||
        error.message ||
        'Failed to send message';
      console.error('Error sending message to Semaphore:', {
        httpStatus,
        data: error.response?.data,
        message: error.message,
      });

      return {
        status: 'error',
        message: httpStatus ? `Semaphore HTTP ${httpStatus}: ${serverMessage}` : serverMessage,
        data: error.response?.data,
        code: error.response?.data?.code,
      };
    }
  }

  async sendBulkMessages(
    messages: Array<{ phoneNumber: string; message: string }>
  ): Promise<SemaphoreResponse[]> {
    const results: SemaphoreResponse[] = [];
    
    // Semaphore has rate limits, so we send sequentially with delays
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      
      // Add delay between messages (1 second minimum to respect rate limits)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const result = await this.sendMessage(msg.phoneNumber, msg.message);
      results.push(result);
      
      console.log(`Message ${i + 1}/${messages.length} sent:`, result.status);
    }
    
    return results;
  }

  async getAccountInfo(): Promise<any> {
    try {
      const response = await this.client.get('/account', {
        params: {
          apikey: this.config.apiKey,
        },
      });
      
      return {
        status: 'success',
        data: response.data,
      };
    } catch (error: any) {
      console.error('Error getting account info:', error.response?.data || error.message);
      const httpStatus = error.response?.status;
      const serverMessage =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        'Failed to get account information';
      return {
        status: 'error',
        message: httpStatus ? `Semaphore HTTP ${httpStatus}: ${serverMessage}` : serverMessage,
        data: error.response?.data,
      };
    }
  }

  async getMessages(limit: number = 100): Promise<any> {
    try {
      const response = await this.client.get('/messages', {
        params: {
          apikey: this.config.apiKey,
          limit,
        },
      });
      
      return {
        status: 'success',
        data: response.data,
      };
    } catch (error: any) {
      console.error('Error getting messages:', error);
      return {
        status: 'error',
        message: 'Failed to get messages',
      };
    }
  }

  replaceVariables(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, variableName) => {
      // Return the variable value if it exists, otherwise keep the placeholder
      return variables[variableName] !== undefined ? variables[variableName] : match;
    });
  }

  validatePhoneNumber(phoneNumber: string): boolean {
    // Philippine mobile number validation
    const cleaned = phoneNumber.replace(/\s+/g, '');
    const pattern = /^(?:\+63|0)9\d{9}$/;
    return pattern.test(cleaned);
  }
}

export const semaphoreAPI = new SemaphoreAPI();