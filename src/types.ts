export interface Config {
  discord: {
    token: string;
    channelId: string;
    categoryChannels?: Record<string, string>;
    useThreads: boolean;
    useCategoryChannels: boolean;
  };
  kagi: {
    apiKey: string;
    summarizeModel: string;
    enableSummarizer: boolean;
  };
  categories: string[];
  polling: {
    intervalHours: number;
  };
}

export interface KiteCategory {
  name: string;
  file: string;
}

export interface KiteIndex {
  timestamp: number;
  categories: KiteCategory[];
  supported_languages: string[];
}

export interface NewsCluster {
  cluster_number: number;
  unique_domains: number;
  number_of_titles: number;
  category: string;
  title: string;
  short_summary: string;
  did_you_know?: string;
  talking_points: string[];
  quote?: string;
  quote_author?: string;
  quote_attribution?: string;
  quote_source_url?: string;
  quote_source_domain?: string;
  location?: string;
  perspectives?: Array<{
    text: string;
    sources: Array<{
      name: string;
      url: string;
    }>;
  }>;
  articles?: Array<{
    title: string;
    link: string;
    domain: string;
    date: string;
    image: string;
    image_caption: string;
  }>;
}

export interface KiteNewsData {
  category: string;
  timestamp: number;
  read: number;
  clusters: NewsCluster[];
}

export interface SentArticle {
  clusterId: string;
  timestamp: number;
  category: string;
  title: string;
}

export interface DailyThread {
  date: string;
  threadId: string;
  channelId: string;
  createdAt: number;
}

export interface KagiSummaryResponse {
  data: {
    output: string;
    tokens: number;
  };
}