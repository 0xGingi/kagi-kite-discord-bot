import axios from 'axios';
import { KagiSummaryResponse } from './types.js';

export class KagiSummarizer {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://kagi.com/api/v0/summarize';
  private readonly maxRetries = 3;
  private readonly baseBackoffMs = 600;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async summarizeText(text: string, model: string = 'cecil'): Promise<string> {
    return this.withRetries(async () => {
      const response = await axios.post(
        this.baseUrl,
        { text, engine: model, summary_type: 'summary' },
        { headers: { 'Authorization': `Bot ${this.apiKey}`, 'Content-Type': 'application/json' } }
      );
      const data: KagiSummaryResponse = response.data;
      return data.data.output;
    });
  }

  async summarizeUrl(url: string, model: string = 'cecil'): Promise<string> {
    return this.withRetries(async () => {
      const response = await axios.post(
        this.baseUrl,
        { url, engine: model, summary_type: 'summary' },
        { headers: { 'Authorization': `Bot ${this.apiKey}`, 'Content-Type': 'application/json' } }
      );
      const data: KagiSummaryResponse = response.data;
      return data.data.output;
    });
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastErr = error;
        const retryable = this.isRetryable(error);
        if (!retryable || attempt === this.maxRetries) {
          if (axios.isAxiosError(error)) {
            throw new Error(`Kagi API error: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
          }
          throw error;
        }
        const delay = this.computeBackoff(attempt, error);
        await new Promise(res => setTimeout(res, delay));
      }
    }
    throw lastErr;
  }

  private isRetryable(error: any): boolean {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (!status) return true; // network error / timeout
      if (status === 429) return true;
      if (status >= 500) return true;
      return false;
    }
    return true;
  }

  private computeBackoff(attempt: number, error: any): number {
    // exponential backoff with jitter
    const base = this.baseBackoffMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    // honor Retry-After if present
    if (axios.isAxiosError(error)) {
      const ra = error.response?.headers?.['retry-after'];
      if (ra) {
        const sec = parseInt(Array.isArray(ra) ? ra[0] : ra, 10);
        if (!isNaN(sec) && sec > 0) return (sec * 1000) + jitter;
      }
    }
    return base + jitter;
  }
}
