import * as cron from 'node-cron';
import { DiscordBot } from './discord-bot.js';

export class NewsScheduler {
  private bot: DiscordBot;
  private task: cron.ScheduledTask | null = null;
  private intervalHours: number;

  constructor(bot: DiscordBot, intervalHours: number = 24) {
    this.bot = bot;
    this.intervalHours = intervalHours;
  }

  start(): void {
    const cronExpression = this.getCronExpression();
    
    console.log(`Starting news scheduler with interval: ${this.intervalHours} hours`);
    console.log(`Cron expression: ${cronExpression}`);

    this.task = cron.schedule(cronExpression, async () => {
      console.log('Scheduled news check starting...');
      try {
        await this.bot.checkAndPostNews();
      } catch (error) {
        console.error('Error during scheduled news check:', error);
      }
    });

    this.task.start();
    
    console.log('Running initial news check...');
    this.bot.checkAndPostNews().catch(error => {
      console.error('Error during initial news check:', error);
    });
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('News scheduler stopped');
    }
  }

  private getCronExpression(): string {
    if (this.intervalHours === 24) {
      return '0 9 * * *';
    } else if (this.intervalHours === 12) {
      return '0 9,21 * * *';
    } else if (this.intervalHours === 6) {
      return '0 9,15,21,3 * * *';
    } else if (this.intervalHours === 1) {
      return '0 * * * *';
    } else {
      const minutes = this.intervalHours * 60;
      if (minutes < 60) {
        return `*/${minutes} * * * *`;
      } else {
        return `0 */${this.intervalHours} * * *`;
      }
    }
  }

  async runManualCheck(): Promise<void> {
    console.log('Running manual news check...');
    try {
      await this.bot.checkAndPostNews();
    } catch (error) {
      console.error('Error during manual news check:', error);
      throw error;
    }
  }
}