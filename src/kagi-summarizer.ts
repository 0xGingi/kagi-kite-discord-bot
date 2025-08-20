import axios from 'axios';
import { KagiSummaryResponse } from './types.js';

export class KagiSummarizer {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://kagi.com/api/v0/summarize';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async summarizeText(text: string, model: string = 'cecil'): Promise<string> {
    try {
      const response = await axios.post(
        this.baseUrl,
        {
          text: text,
          engine: model,
          summary_type: 'summary'
        },
        {
          headers: {
            'Authorization': `Bot ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const data: KagiSummaryResponse = response.data;
      return data.data.output;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Kagi API error: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
      }
      throw new Error(`Failed to summarize text: ${error}`);
    }
  }

  async summarizeUrl(url: string, model: string = 'cecil'): Promise<string> {
    try {
      const response = await axios.post(
        this.baseUrl,
        {
          url: url,
          engine: model,
          summary_type: 'summary'
        },
        {
          headers: {
            'Authorization': `Bot ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const data: KagiSummaryResponse = response.data;
      return data.data.output;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Kagi API error: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
      }
      throw new Error(`Failed to summarize URL: ${error}`);
    }
  }
}