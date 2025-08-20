import { promises as fs } from 'fs';
import { SentArticle } from './types.js';

export class Storage {
  private readonly filePath: string;
  private sentArticles: Map<string, SentArticle> = new Map();

  constructor(filePath?: string) {
    // Default path logic: use ./sent-articles.json for development, ./data/sent-articles.json for production/Docker
    this.filePath = filePath || (process.env.NODE_ENV === 'production' ? './data/sent-articles.json' : './sent-articles.json');
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const path = require('path');
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      
      const data = await fs.readFile(this.filePath, 'utf-8');
      const articles: SentArticle[] = JSON.parse(data);
      
      for (const article of articles) {
        this.sentArticles.set(article.clusterId, article);
      }
      
      console.log(`Loaded ${articles.length} previously sent articles from ${this.filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Try fallback location for backward compatibility
        await this.tryLoadFromFallbackLocation();
      } else {
        console.error('Error loading sent articles:', error);
      }
    }
  }

  private async tryLoadFromFallbackLocation(): Promise<void> {
    const fallbackPath = './sent-articles.json';
    if (this.filePath === fallbackPath) {
      console.log('No existing sent articles file found, starting fresh');
      return;
    }

    try {
      console.log(`Trying fallback location: ${fallbackPath}`);
      const data = await fs.readFile(fallbackPath, 'utf-8');
      const articles: SentArticle[] = JSON.parse(data);
      
      for (const article of articles) {
        this.sentArticles.set(article.clusterId, article);
      }
      
      console.log(`Loaded ${articles.length} previously sent articles from ${fallbackPath}`);
      console.log(`Migrating to new location: ${this.filePath}`);
      
      // Save to new location
      await this.save();
    } catch (fallbackError) {
      console.log('No existing sent articles file found, starting fresh');
    }
  }

  async save(): Promise<void> {
    try {
      const articles = Array.from(this.sentArticles.values());
      await fs.writeFile(this.filePath, JSON.stringify(articles, null, 2));
    } catch (error) {
      console.error('Error saving sent articles:', error);
      throw error;
    }
  }

  isArticleSent(clusterId: string): boolean {
    return this.sentArticles.has(clusterId);
  }

  markArticleSent(article: SentArticle): void {
    this.sentArticles.set(article.clusterId, article);
  }

  async cleanup(olderThanDays: number = 30): Promise<void> {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let removedCount = 0;

    for (const [clusterId, article] of this.sentArticles.entries()) {
      if (article.timestamp < cutoff) {
        this.sentArticles.delete(clusterId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} old article records`);
      await this.save();
    }
  }

  getStats(): { total: number; oldestTimestamp: number; newestTimestamp: number } {
    const articles = Array.from(this.sentArticles.values());
    
    if (articles.length === 0) {
      return { total: 0, oldestTimestamp: 0, newestTimestamp: 0 };
    }

    const timestamps = articles.map(a => a.timestamp);
    return {
      total: articles.length,
      oldestTimestamp: Math.min(...timestamps),
      newestTimestamp: Math.max(...timestamps)
    };
  }
}