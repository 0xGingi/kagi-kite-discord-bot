import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
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
        // XML-only ingestion: derive .xml file and ignore JSON source
        const xmlFile = categoryInfo.file.toLowerCase().endsWith('.xml')
          ? categoryInfo.file
          : categoryInfo.file.replace(/\.json$/i, '.xml');

        console.log(`[RSS] Fetching ${categoryName} from ${xmlFile}`);
        const xmlData = await this.getCategoryNews(xmlFile);

        // Ensure category is set on each cluster
        const enriched = xmlData.clusters.map(c => {
          const cc: NewsCluster = { ...c };
          cc.category = categoryName;
          // Ensure quote_source_url present if articles contain link
          if (!cc.quote_source_url && cc.articles && cc.articles[0]?.link) {
            cc.quote_source_url = cc.articles[0].link;
          }
          // Fallback: try perspectives first source URL
          if (!cc.quote_source_url && Array.isArray(cc.perspectives) && cc.perspectives[0]?.sources?.[0]?.url) {
            cc.quote_source_url = cc.perspectives[0].sources[0].url;
          }
          // Fallback: try to extract any URL from short_summary
          if (!cc.quote_source_url && typeof cc.short_summary === 'string' && cc.short_summary.length > 0) {
            const m = cc.short_summary.match(/https?:\/\/[^\s<>"']+/i);
            if (m) cc.quote_source_url = m[0];
          }
        
          // Guarantee a non-empty title: prefer summary-based title, then URL
          if (!cc.title || cc.title.trim().length === 0 || this.looksLikeHostname(cc.title)) {
            const candidateUrl = cc.quote_source_url || cc.articles?.[0]?.link || (Array.isArray(cc.perspectives) && cc.perspectives[0]?.sources?.[0]?.url) || undefined;
            cc.title = this.deriveTitleFromSummary(cc.short_summary)
              || this.deriveTitleFromUrl(candidateUrl)
              || 'Untitled';
          }

          return cc;
        });

        results.push({
          category: categoryName,
          clusters: enriched,
          timestamp: xmlData.timestamp
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
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      trimValues: true,
      allowBooleanAttributes: true,
    });
    let obj: any;
    try {
      obj = parser.parse(xml);
    } catch (e) {
      console.error('Failed to parse RSS XML:', e);
      return { category: '', timestamp: Math.floor(Date.now() / 1000), read: 0, clusters: [] };
    }

    const channel = obj?.rss?.channel;
    const lastBuildDate: string = channel?.lastBuildDate || '';
    const feedTsMs = lastBuildDate ? Date.parse(lastBuildDate) : Date.now();
    const feedTs = Math.floor(feedTsMs / 1000);

    const rawItems = channel?.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
    const items: NewsCluster[] = [];

    let idx = 0;
    for (const it of rawItems) {
      const titleRaw = (typeof it.title === 'string') ? it.title : '';
      const contentEncoded = it['content:encoded'] as string | undefined;
      const descHtml = contentEncoded || (typeof it.description === 'string' ? it.description : undefined);
      const summary = this.summarizeHtmlContent(descHtml);
      const pubDateStr = typeof it.pubDate === 'string' ? it.pubDate : undefined;
      const pubTs = pubDateStr ? Math.floor(Date.parse(pubDateStr) / 1000) : feedTs;

      // Link resolution: prefer <link>, then GUID when it's a URL, then any href in description
      let link = this.sanitizeUrlCandidate(it.link)
        || this.sanitizeUrlCandidate(it.guid)
        || (descHtml ? (descHtml.match(/href=['\"][^'\"\s>]+['\"]/i)?.[0]?.replace(/^href=['\"]/i, '').replace(/['\"]$/, '')) : undefined)
        || this.pickBestItemUrl(JSON.stringify(it));

      let title = this.cleanText(this.stripTags(titleRaw || ''));
      if (!title || this.looksLikeHostname(title)) {
        title = this.deriveTitleFromSummary(summary) || this.deriveTitleFromUrl(link) || 'Untitled';
      }

      if (idx < 3) {
        console.log(`[RSS] Item #${idx} titleCandidate=\"${(title||'').slice(0,80)}\" link=${link || 'N/A'} sumLen=${(summary||'').length}`);
      }

      const cluster: NewsCluster = {
        cluster_number: this.stableNumber((it.guid as string) || link || `${idx}-${title}`),
        unique_domains: 1,
        number_of_titles: 1,
        category: '',
        title: title,
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

    return { category: '', timestamp: feedTs, read: 0, clusters: items };
  }

  private extractTag(block: string, tag: string): string | undefined {
    const re = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
    const match = block.match(re);
    if (!match) return undefined;
    return match[1].replace(/^\s+|\s+$/g, '');
  }

  private unwrapCdata(text?: string): string | undefined {
    if (typeof text !== 'string') return text;
    return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  }

  private sanitizeUrlCandidate(text?: any): string | undefined {
    if (!text) return undefined;
    if (typeof text !== 'string') {
      // fast-xml-parser may represent nodes with attributes as objects with #text
      const possible = (text['#text'] || text.text || text._ || '').toString();
      if (!possible) return undefined;
      text = possible;
    }
    const cleaned = (text as string).replace(/\s+/g, ' ').trim();
    const m = cleaned.match(/https?:\/\/[^\s<>'\"]+/i);
    return m ? m[0] : undefined;
  }

  private deriveTitleFromSummary(summary?: string): string | null {
    if (!summary) return null;
    const s = summary.trim();
    if (!s) return null;
    // Use first sentence or first ~12 words
    const firstSentenceMatch = s.match(/^(.+?[.!?])\s+/);
    const candidate = firstSentenceMatch ? firstSentenceMatch[1] : s.split(/\s+/).slice(0, 14).join(' ');
    // Guard against overlong titles
    return candidate.length > 140 ? candidate.slice(0, 137) + '…' : candidate;
  }

  private looksLikeHostname(text?: string): boolean {
    if (!text) return false;
    const t = text.trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) && !/\s/.test(t);
  }

  private pickBestItemUrl(block: string): string | undefined {
    const urls = block.match(/https?:\/\/[^\s<>'\"]+/gi) || [];
    if (urls.length === 0) return undefined;
    // Prefer kite item URLs over image proxy links
    const preferred = urls.find(u => /kite\.kagi\.com\//i.test(u));
    if (preferred) return preferred;
    // De-prioritize image proxy links
    const nonImg = urls.find(u => !/kagiproxy\.com\/img\//i.test(u));
    return nonImg || urls[0];
  }

  private extractFirstParagraph(html?: string): string | undefined {
    if (!html) return undefined;
    const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const p = m[1] ?? '';
      const text = this.cleanText(this.stripTags(p));
      const withoutCites = this.removeKiteCitations(text);
      if (withoutCites && withoutCites.replace(/[\W_]/g, '').length > 0) {
        return p;
      }
    }
    return undefined;
  }

  private stripTags(html: string): string {
    const s = this.unwrapCdata(html) ?? '';
    return s.replace(/<[^>]*>/g, ' ');
  }

  private cleanText(text: string): string {
    return this.decodeEntities(text)
      .replace(/\s+/g, ' ')
      .replace(/\s+\./g, '.')
      .replace(/\.\s*\./g, '.')
      .trim();
  }

  private removeKiteCitations(text: string): string {
    return text.replace(/\[[\w.-]+(?:\.[\w]+)*#\d+\]/g, '').trim();
  }

  private summarizeHtmlContent(html?: string): string {
    if (!html) return '';
    const p = this.extractFirstParagraph(html);
    let text = this.cleanText(this.stripTags(p ?? ''));
    text = this.removeKiteCitations(text);
    if (text.length >= 1) return text;

    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    const items: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = liRe.exec(html)) !== null && items.length < 3) {
      const li = this.removeKiteCitations(this.cleanText(this.stripTags(m[1] ?? '')));
      if (li) items.push(li);
    }
    if (items.length) return items.join(' • ');

    return this.removeKiteCitations(this.cleanText(this.stripTags(html)));
  }

  private deriveTitleFromUrl(url?: string | null): string | null {
    if (!url) return null;
    try {
      const u = new URL(url.trim());
      const parts = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p));
      if (parts.length === 0) return u.hostname;
      // Prefer the last meaningful segment
      let candidate = parts[parts.length - 1];
      if (!candidate || /^(\d+|index|home)$/i.test(candidate)) {
        // Try previous non-numeric, non-generic segment
        for (let i = parts.length - 2; i >= 0; i--) {
          const seg = parts[i];
          if (seg && !/^(\d+|index|home)$/i.test(seg) && !/^[a-f0-9-]{8,}$/i.test(seg)) {
            candidate = seg; break;
          }
        }
      }
      if (!candidate) return u.hostname;
      const words = candidate.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      return words.length >= 3 ? words : (words || u.hostname);
    } catch {
      return null;
    }
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
