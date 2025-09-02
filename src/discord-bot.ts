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
        let alreadySent = 0;
        let newCount = 0;
        for (const cluster of clusters) {
          const tsForId = (cluster as any)._pubTs ?? timestamp;
          const clusterId = this.kiteScraper.generateClusterId(cluster, category, tsForId);
          if (this.storage.isArticleSent(clusterId)) {
            alreadySent++;
          } else {
            newCount++;
          }
        }
        console.log(`[${category}] clusters=${clusters.length} ts=${timestamp} new=${newCount} dup=${alreadySent}`);
      }

      for (const { category, clusters, timestamp } of newsResults) {
        for (const cluster of clusters) {
          const tsForId = (cluster as any)._pubTs ?? timestamp;
          const clusterId = this.kiteScraper.generateClusterId(cluster, category, tsForId);
          
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

      // Derive a stable title early for logs and posting
      let linkUrlForTitle = cluster.quote_source_url || cluster.articles?.[0]?.link || '';
      if (!linkUrlForTitle && Array.isArray(cluster.perspectives) && cluster.perspectives[0]?.sources?.[0]?.url) {
        linkUrlForTitle = cluster.perspectives[0].sources[0].url;
      }
      if (!linkUrlForTitle && typeof cluster.short_summary === 'string') {
        const m = cluster.short_summary.match(/https?:\/\/[^\s<>"']+/i);
        if (m) linkUrlForTitle = m[0];
      }
      const rawClusterTitle = (cluster.title || '').trim();
      const postTitle = (!rawClusterTitle || this.looksLikeHostname(rawClusterTitle))
        ? (this.deriveTitleFromSummary(cluster.short_summary) || this.deriveTitleFromUrl(linkUrlForTitle) || 'Untitled')
        : rawClusterTitle;

      let summary = cluster.short_summary;

      if (this.config.kagi.enableSummarizer) {
        try {
          const hasText = !!(cluster.short_summary && cluster.short_summary.trim().length > 0);
          if (hasText) {
            summary = await this.kagiSummarizer.summarizeText(
              cluster.short_summary, 
              this.config.kagi.summarizeModel
            );
          } else {
            // Prefer the same candidate we use for title derivation
            let linkUrl = linkUrlForTitle;
            if (!linkUrl && cluster.perspectives && cluster.perspectives.length > 0) {
              const firstSource = cluster.perspectives[0].sources?.[0];
              if (firstSource?.url) linkUrl = firstSource.url;
            }
            if (linkUrl && !this.isLikelyFeedOrHost(linkUrl)) {
              summary = await this.kagiSummarizer.summarizeUrl(
                linkUrl,
                this.config.kagi.summarizeModel
              );
            } else {
              summary = '';
            }
          }
        } catch (summaryError) {
          console.warn(`Failed to get Kagi summary for article "${postTitle}", using original summary:`, summaryError);
          summary = this.cleanKiteCitations(cluster.short_summary);
        }
      } else {
        summary = this.cleanKiteCitations(cluster.short_summary);
      }

      const embed = this.createNewsEmbed(cluster, category, summary);

      if (postTitle === 'Untitled') {
        const firstArticleLink = cluster.articles?.[0]?.link || '';
        console.warn('Debug: Untitled post computed. Inspecting fields:', {
          rawTitle: cluster.title,
          linkUrlForTitle,
          quote_source_url: cluster.quote_source_url,
          firstArticleLink
        });
      }
      
      if (this.config.discord.useThreads) {
        const today = new Date().toISOString().split('T')[0];
        const thread = await this.getOrCreateDailyThread(channel, today, category);
        await thread.send({ embeds: [embed] });
        console.log(`Posted article to thread: ${postTitle}`);
      } else {
        await channel.send({ embeds: [embed] });
        console.log(`Posted article to channel: ${postTitle}`);
      }

      const sentArticle: SentArticle = {
        clusterId,
        timestamp: Date.now(),
        category,
        title: postTitle
      };

      this.storage.markArticleSent(sentArticle);
    } catch (error) {
      console.error(`Error processing article "${cluster.title}":`, error);
    }
  }

  private createNewsEmbed(cluster: NewsCluster, category: string, summary: string): EmbedBuilder {
    const linkUrlCandidate = cluster.quote_source_url || cluster.articles?.[0]?.link || '';
    const derivedFromSummary = this.deriveTitleFromSummary(summary || cluster.short_summary);
    const derivedFromUrl = this.deriveTitleFromUrl(linkUrlCandidate);
    const rawClusterTitle = (cluster.title || '').trim();
    const title = (!rawClusterTitle || this.looksLikeHostname(rawClusterTitle))
      ? (derivedFromSummary || derivedFromUrl || 'Untitled')
      : rawClusterTitle;

    let safeSummary = (summary && summary.trim().length > 0) ? summary : null;
    if (!safeSummary && Array.isArray(cluster.talking_points) && cluster.talking_points.length > 0) {
      const bullets = cluster.talking_points
        .map(tp => (tp || '').toString().trim())
        .filter(Boolean)
        .slice(0, 3);
      if (bullets.length) safeSummary = bullets.join(' • ');
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(safeSummary)
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

    if (!linkUrl && typeof summary === 'string' && summary.length > 0) {
      const m = summary.match(/https?:\/\/[^\s<>"']+/i);
      if (m) linkUrl = m[0];
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

  private deriveTitleFromUrl(url?: string): string | null {
    if (!url) return null;
    try {
      const u = new URL(url.trim());
      const parts = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p));
      if (parts.length === 0) return u.hostname;
      let candidate = parts[parts.length - 1];
      if (!candidate || /^(\d+|index|home)$/i.test(candidate)) {
        for (let i = parts.length - 2; i >= 0; i--) {
          const seg = parts[i];
          if (seg && !/^(\d+|index|home)$/i.test(seg) && !/^[a-f0-9-]{8,}$/i.test(seg)) { candidate = seg; break; }
        }
      }
      if (!candidate) return u.hostname;
      const words = candidate.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      return words.length >= 3 ? words : (words || u.hostname);
    } catch {
      return null;
    }
  }

  private deriveTitleFromSummary(summary?: string | null): string | null {
    if (!summary) return null;
    const s = summary.trim();
    if (!s) return null;
    const firstSentenceMatch = s.match(/^(.+?[.!?])\s+/);
    const candidate = firstSentenceMatch ? firstSentenceMatch[1] : s.split(/\s+/).slice(0, 14).join(' ');
    return candidate.length > 140 ? candidate.slice(0, 137) + '…' : candidate;
  }

  private looksLikeHostname(text: string): boolean {
    const t = text.trim();
    // Very short or contains a dot and no spaces: likely a hostname like example.com
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) && !/\s/.test(t)) return true;
    return false;
  }

  private isLikelyFeedOrHost(url: string): boolean {
    try {
      const u = new URL(url);
      if (!u.pathname || u.pathname === '/' ) return true; // bare host
      // treat .xml feeds or kite category roots as not good for summarization
      if (/\.xml$/i.test(u.pathname)) return true;
      return false;
    } catch {
      return true;
    }
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
