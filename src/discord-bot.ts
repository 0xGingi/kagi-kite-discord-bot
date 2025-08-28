import { Client, GatewayIntentBits, TextChannel, ThreadChannel, EmbedBuilder } from 'discord.js';
import { KiteScraper } from './kite-scraper.js';
import { KagiSummarizer } from './kagi-summarizer.js';
import { Storage } from './storage.js';
import { Config, NewsCluster, SentArticle, DailyThread } from './types.js';

export class DiscordBot {
  private client: Client;
  private config: Config;
  private kiteScraper: KiteScraper;
  private kagiSummarizer: KagiSummarizer;
  private storage: Storage;
  private isChecking: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });
    
    this.kiteScraper = new KiteScraper();
    this.kagiSummarizer = new KagiSummarizer(config.kagi.apiKey);
    this.storage = new Storage();
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    
    this.client.once('clientReady', () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
    });

    await this.client.login(this.config.discord.token);
  }

  async checkAndPostNews(): Promise<void> {
    if (this.isChecking) {
      console.log('News check already in progress, skipping...');
      return;
    }

    this.isChecking = true;
    try {
      console.log('Checking for new articles...');
      const newsResults = await this.kiteScraper.getNewsClusters(this.config.categories);
      let newArticlesCount = 0;

      for (const { category, clusters, timestamp } of newsResults) {
        for (const cluster of clusters) {
          const clusterId = this.kiteScraper.generateClusterId(cluster, category, timestamp);
          
          if (!this.storage.isArticleSent(clusterId)) {
            await this.processAndPostArticle(cluster, category, clusterId);
            newArticlesCount++;
            
            await this.sleep(2000);
          }
        }
      }

      console.log(`Posted ${newArticlesCount} new articles`);
      await this.storage.save();
      
      await this.storage.cleanup(30);
      await this.storage.cleanupOldThreads(30);
    } catch (error) {
      console.error('Error checking and posting news:', error);
    } finally {
      this.isChecking = false;
    }
  }

  private async getOrCreateDailyThread(channel: TextChannel, date: string, category: string): Promise<ThreadChannel> {
    const threadKey = `${category}-${date}`;
    
    const existingThread = this.storage.getDailyThread(threadKey);
    if (existingThread) {
      try {
        const thread = await this.client.channels.fetch(existingThread.threadId) as ThreadChannel;
        if (thread) {
          return thread;
        }
      } catch (error) {
        console.warn(`Failed to fetch existing thread ${existingThread.threadId}, creating new one:`, error);
      }
    }

    const threadName = `${category} - ${date}`;
    const startMessage = await channel.send(`**${threadName}**\n\n*Collecting ${category.toLowerCase()} news articles...*`);
    
    const thread = await startMessage.startThread({
      name: threadName,
      autoArchiveDuration: 1440,
    });

    const dailyThread: DailyThread = {
      date: threadKey,
      threadId: thread.id,
      channelId: channel.id,
      createdAt: Date.now()
    };

    this.storage.saveDailyThread(dailyThread);
    await this.storage.saveThreads();

    console.log(`Created new category thread: ${threadName} (${thread.id})`);
    return thread;
  }

  private async processAndPostArticle(cluster: NewsCluster, category: string, clusterId: string): Promise<void> {
    try {
      let channelId: string;
      if (this.config.discord.useCategoryChannels && this.config.discord.categoryChannels?.[category]) {
        channelId = this.config.discord.categoryChannels[category];
      } else {
        channelId = this.config.discord.channelId;
      }

      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      
      if (!channel) {
        throw new Error(`Could not find Discord channel: ${channelId}`);
      }

      let summary = cluster.short_summary;
      
      if (this.config.kagi.enableSummarizer) {
        try {
          summary = await this.kagiSummarizer.summarizeText(
            cluster.short_summary, 
            this.config.kagi.summarizeModel
          );
        } catch (summaryError) {
          console.warn(`Failed to get Kagi summary for article "${cluster.title}", using original summary:`, summaryError);
        }
      } else {
        summary = this.cleanKiteCitations(cluster.short_summary);
      }

      const embed = this.createNewsEmbed(cluster, category, summary);
      
      if (this.config.discord.useThreads) {
        const today = new Date().toISOString().split('T')[0];
        const thread = await this.getOrCreateDailyThread(channel, today, category);
        await thread.send({ embeds: [embed] });
        console.log(`Posted article to thread: ${cluster.title}`);
      } else {
        await channel.send({ embeds: [embed] });
        console.log(`Posted article to channel: ${cluster.title}`);
      }

      const sentArticle: SentArticle = {
        clusterId,
        timestamp: Date.now(),
        category,
        title: cluster.title
      };

      this.storage.markArticleSent(sentArticle);
    } catch (error) {
      console.error(`Error processing article "${cluster.title}":`, error);
    }
  }

  private createNewsEmbed(cluster: NewsCluster, category: string, summary: string): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(cluster.title)
      .setDescription(summary)
      .setColor('#0066cc')
      .addFields({ name: 'Category', value: category, inline: true })
      .setTimestamp();

    let linkUrl = cluster.quote_source_url;
    
    if (!linkUrl && cluster.articles && cluster.articles.length > 0) {
      linkUrl = cluster.articles[0].link;
    }
    
    if (!linkUrl && cluster.perspectives && cluster.perspectives.length > 0) {
      const firstSource = cluster.perspectives[0].sources?.[0];
      if (firstSource) {
        linkUrl = firstSource.url;
      }
    }

    if (linkUrl) {
      embed.setURL(linkUrl);
    }

    if (cluster.location) {
      embed.addFields({ 
        name: 'Location', 
        value: cluster.location, 
        inline: true 
      });
    }

    return embed;
  }

  private cleanKiteCitations(text: string): string {
    return text
      .replace(/\[[\w.-]+(?:\.[\w]+)*#\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+\./g, '.')
      .replace(/\.\s*\./g, '.')
      .trim();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down Discord bot...');
    await this.storage.save();
    await this.storage.saveThreads();
    await this.client.destroy();
  }
}