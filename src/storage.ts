import { promises as fs } from 'fs';
import { SentArticle, DailyThread } from './types.js';

export class Storage {
  private readonly filePath: string;
  private readonly threadsFilePath: string;
  private sentArticles: Map<string, SentArticle> = new Map();
  private dailyThreads: Map<string, DailyThread> = new Map();

  constructor(filePath?: string) {
    this.filePath = filePath || (process.env.NODE_ENV === 'production' ? './data/sent-articles.json' : './sent-articles.json');
    this.threadsFilePath = filePath ? filePath.replace('sent-articles.json', 'daily-threads.json') : (process.env.NODE_ENV === 'production' ? './data/daily-threads.json' : './daily-threads.json');
  }

  async initialize(): Promise<void> {
    try {
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
        await this.tryLoadFromFallbackLocation();
      } else {
        console.error('Error loading sent articles:', error);
      }
    }

    await this.loadThreads();
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
      
      await this.save();
    } catch (fallbackError) {
      console.log('No existing sent articles file found, starting fresh');
    }
  }

  private async loadThreads(): Promise<void> {
    try {
      const data = await fs.readFile(this.threadsFilePath, 'utf-8');
      const threads: DailyThread[] = JSON.parse(data);
      
      for (const thread of threads) {
        this.dailyThreads.set(thread.date, thread);
      }
      
      console.log(`Loaded ${threads.length} daily threads from ${this.threadsFilePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error loading daily threads:', error);
      } else {
        console.log('No existing daily threads file found, starting fresh');
      }
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

  async saveThreads(): Promise<void> {
    try {
      const threads = Array.from(this.dailyThreads.values());
      await fs.writeFile(this.threadsFilePath, JSON.stringify(threads, null, 2));
    } catch (error) {
      console.error('Error saving daily threads:', error);
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

  getDailyThread(date: string): DailyThread | undefined {
    return this.dailyThreads.get(date);
  }

  saveDailyThread(thread: DailyThread): void {
    this.dailyThreads.set(thread.date, thread);
  }

  async cleanupOldThreads(olderThanDays: number = 30): Promise<void> {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let removedCount = 0;

    for (const [date, thread] of this.dailyThreads.entries()) {
      if (thread.createdAt < cutoff) {
        this.dailyThreads.delete(date);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} old thread records`);
      await this.saveThreads();
    }
  }
}