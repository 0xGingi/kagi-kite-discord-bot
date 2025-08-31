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
    const url = `${this.baseUrl}${categoryFile}`;
    const isXml = categoryFile.toLowerCase().endsWith('.xml');
    try {
      if (isXml) {
        const response = await axios.get(url, { responseType: 'text' });
        return this.parseRssToNewsData(response.data);
      } else {
        const response = await axios.get(url);
        return response.data;
      }
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
        const primary = await this.getCategoryNews(categoryInfo.file);

        let combinedClusters: NewsCluster[] = [...primary.clusters];
        let combinedTs = primary.timestamp;

        if (categoryInfo.file.toLowerCase().endsWith('.json')) {
          const xmlFile = categoryInfo.file.replace(/\.json$/i, '.xml');
          try {
            const xmlData = await this.getCategoryNews(xmlFile);

            const seenTitles = new Set(
              combinedClusters.map(c => this.normalizeTitle(c.title))
            );

            for (const xc of xmlData.clusters) {
              const t = this.normalizeTitle(xc.title);
              if (!seenTitles.has(t)) {
                combinedClusters.push(xc);
                seenTitles.add(t);
              }
            }
            combinedTs = Math.max(combinedTs, xmlData.timestamp);
          } catch (xmlErr) {
            console.warn(`No XML fallback for ${categoryName} (${xmlFile}) or failed to parse:`, xmlErr?.toString?.());
          }
        }

        results.push({
          category: categoryName,
          clusters: combinedClusters,
          timestamp: combinedTs
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

  private parseRssToNewsData(xml: string): KiteNewsData {
    const lastBuildMatch = xml.match(/<lastBuildDate>([\s\S]*?)<\/lastBuildDate>/i);
    const lastBuildDate = lastBuildMatch ? lastBuildMatch[1].trim() : '';
    const feedTsMs = lastBuildDate ? Date.parse(lastBuildDate) : Date.now();
    const feedTs = Math.floor(feedTsMs / 1000);

    const items: NewsCluster[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = this.extractTag(block, 'title');
      const link = this.extractTag(block, 'link');
      const guid = this.extractTag(block, 'guid');
      const pubDateStr = this.extractTag(block, 'pubDate');
      const pubTs = pubDateStr ? Math.floor(Date.parse(pubDateStr) / 1000) : feedTs;
      const descHtml = this.extractTag(block, 'description');
      const firstP = this.extractFirstParagraph(descHtml);
      const summary = this.cleanText(firstP || this.stripTags(descHtml || '')).trim();

      const cluster: NewsCluster = {
        cluster_number: this.stableNumber(guid || link || `${idx}-${title}`),
        unique_domains: 1,
        number_of_titles: 1,
        category: '',
        title: title || (link || '').split('/').pop() || 'Untitled',
        short_summary: summary || '',
        talking_points: [],
        quote_source_url: link?.trim() || undefined,
        quote_source_domain: this.tryGetDomain(link),
        articles: link ? [{ title: title || 'Article', link: link.trim(), domain: this.tryGetDomain(link) || '', date: pubDateStr || '', image: '', image_caption: '' }] : undefined,
      };
      (cluster as any)._pubTs = pubTs;

      items.push(cluster);
      idx++;
    }

    return {
      category: '',
      timestamp: feedTs,
      read: 0,
      clusters: items,
    };
  }

  private extractTag(block: string, tag: string): string | undefined {
    const re = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
    const match = block.match(re);
    if (!match) return undefined;
    return match[1].replace(/^\s+|\s+$/g, '');
  }

  private extractFirstParagraph(html?: string): string | undefined {
    if (!html) return undefined;
    const m = html.match(/<p>([\s\S]*?)<\/p>/i);
    return m ? m[1] : undefined;
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, ' ');
  }

  private cleanText(text: string): string {
    return this.decodeEntities(text)
      .replace(/\s+/g, ' ')
      .replace(/\s+\./g, '.')
      .replace(/\.\s*\./g, '.')
      .trim();
  }

  private decodeEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'");
  }

  private tryGetDomain(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      const u = new URL(url.trim());
      return u.hostname;
    } catch {
      return undefined;
    }
  }

  private stableNumber(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private normalizeTitle(t: string): string {
    return (t || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}
