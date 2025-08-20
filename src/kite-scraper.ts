import axios from 'axios';
import { KiteIndex, KiteNewsData, NewsCluster } from './types.js';

export class KiteScraper {
  private readonly baseUrl = 'https://kite.kagi.com/';

  async getAvailableCategories(): Promise<KiteIndex> {
    try {
      const response = await axios.get(`${this.baseUrl}kite.json`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch categories: ${error}`);
    }
  }

  async getCategoryNews(categoryFile: string): Promise<KiteNewsData> {
    try {
      const response = await axios.get(`${this.baseUrl}${categoryFile}`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch news for ${categoryFile}: ${error}`);
    }
  }

  async getNewsClusters(categories: string[]): Promise<Array<{ category: string; clusters: NewsCluster[]; timestamp: number }>> {
    const kiteIndex = await this.getAvailableCategories();
    const results: Array<{ category: string; clusters: NewsCluster[]; timestamp: number }> = [];

    for (const categoryName of categories) {
      const categoryInfo = kiteIndex.categories.find(cat => cat.name === categoryName);
      
      if (!categoryInfo) {
        console.warn(`Category "${categoryName}" not found in available categories`);
        continue;
      }

      try {
        const newsData = await this.getCategoryNews(categoryInfo.file);
        results.push({
          category: categoryName,
          clusters: newsData.clusters,
          timestamp: newsData.timestamp
        });
      } catch (error) {
        console.error(`Failed to fetch news for category ${categoryName}:`, error);
      }
    }

    return results;
  }

  generateClusterId(cluster: NewsCluster, category: string, timestamp: number): string {
    const titleHash = cluster.title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return `${category}-${cluster.cluster_number}-${timestamp}-${titleHash.slice(0, 30)}`;
  }
}