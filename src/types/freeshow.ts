export interface FreeShowVariable {
  id: string;
  name: string;
  value: string;
  type?: string;
  enabled?: boolean;
}

export interface FreeShowActionResponse {
  status: string;
  message?: string;
  data?: any;
}

export interface FreeShowConfig {
  apiKey: string;
  baseUrl: string;
  port?: number;
}