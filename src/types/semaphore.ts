export interface SemaphoreConfig {
  apiKey: string;
  senderName: string;
}

export interface SemaphoreResponse {
  status: string;
  message: string;
  data?: any;
}