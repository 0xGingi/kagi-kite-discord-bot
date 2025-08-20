import { promises as fs } from 'fs';
import { DiscordBot } from './discord-bot.js';
import { NewsScheduler } from './scheduler.js';
import { Config } from './types.js';

async function loadConfig(): Promise<Config> {
  try {
    const configData = await fs.readFile('./config.json', 'utf-8');
    return JSON.parse(configData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('Config file not found. Please create config.json based on config.example.json');
      process.exit(1);
    }
    throw error;
  }
}

function validateConfig(config: Config): void {
  if (!config.discord?.token) {
    throw new Error('Discord token is required in config.json');
  }
  
  if (!config.discord?.channelId) {
    throw new Error('Discord channel ID is required in config.json');
  }
  
  if (config.kagi?.enableSummarizer && !config.kagi?.apiKey) {
    throw new Error('Kagi API key is required when summarizer is enabled in config.json');
  }
  
  if (!config.categories || config.categories.length === 0) {
    throw new Error('At least one category must be specified in config.json');
  }
}

async function main(): Promise<void> {
  try {
    console.log('Starting Kagi Kite Discord Bot...');
    
    const config = await loadConfig();
    validateConfig(config);
    
    console.log(`Monitoring categories: ${config.categories.join(', ')}`);
    console.log(`Using Kagi summarize model: ${config.kagi.summarizeModel}`);
    console.log(`Polling interval: ${config.polling.intervalHours} hours`);
    
    const bot = new DiscordBot(config);
    await bot.initialize();
    
    const scheduler = new NewsScheduler(bot, config.polling.intervalHours);
    scheduler.start();
    
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      scheduler.stop();
      await bot.shutdown();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM, shutting down gracefully...');
      scheduler.stop();
      await bot.shutdown();
      process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
    
    console.log('Bot is running! Press Ctrl+C to stop.');
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}