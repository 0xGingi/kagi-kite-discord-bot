import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js';
import { KiteScraper } from './kite-scraper.js';
import { KagiSummarizer } from './kagi-summarizer.js';
import { Storage } from './storage.js';
import { Config, NewsCluster, SentArticle } from './types.js';

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
    
    this.client.once('ready', () => {
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
    } catch (error) {
      console.error('Error checking and posting news:', error);
    } finally {
      this.isChecking = false;
    }
  }

  private async processAndPostArticle(cluster: NewsCluster, category: string, clusterId: string): Promise<void> {
    try {
      const channelId = this.config.discord.categoryChannels?.[category] || this.config.discord.channelId;
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
        // Clean up citation markers from original summary
        summary = this.cleanKiteCitations(cluster.short_summary);
      }

      const embed = this.createNewsEmbed(cluster, category, summary);
      await channel.send({ embeds: [embed] });

      const sentArticle: SentArticle = {
        clusterId,
        timestamp: Date.now(),
        category,
        title: cluster.title
      };

      this.storage.markArticleSent(sentArticle);
      console.log(`Posted article: ${cluster.title}`);
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

    // Priority: quote_source_url > first article link > first perspective source URL
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
    // Remove citation markers like [reuters.com#1], [bbc.com#2], etc.
    // Pattern matches: [domain.com#number] or [domain#number] - handles multiple consecutive citations
    return text
      .replace(/\[[\w.-]+(?:\.[\w]+)*#\d+\]/g, '')  // Remove [domain.com#1] style citations
      .replace(/\s+/g, ' ')                         // Collapse multiple spaces
      .replace(/\s+\./g, '.')                       // Fix spaces before periods
      .replace(/\.\s*\./g, '.')                     // Fix double periods
      .trim();                                      // Remove leading/trailing whitespace
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down Discord bot...');
    await this.storage.save();
    await this.client.destroy();
  }
}