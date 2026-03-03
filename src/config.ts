import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, ChannelConfig, BotConfig } from './types.js';

let _config: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? process.env.COPILOT_BRIDGE_CONFIG ?? path.join(process.cwd(), 'config.json');
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}. Copy config.sample.json to config.json and edit it.`);
  }
  
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  
  // Validate platforms
  if (!raw.platforms || typeof raw.platforms !== 'object') {
    throw new Error('Config must have a "platforms" object');
  }
  for (const [name, platform] of Object.entries(raw.platforms)) {
    const p = platform as any;
    if (!p.url) throw new Error(`Platform "${name}" missing "url"`);
    if (!p.botToken && !p.bots) throw new Error(`Platform "${name}" needs either "botToken" or "bots"`);
    if (p.bots) {
      for (const [botName, bot] of Object.entries(p.bots)) {
        if (!(bot as any).token) throw new Error(`Platform "${name}" bot "${botName}" missing "token"`);
      }
    }
  }
  
  // Validate channels
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error('Config must have at least one channel');
  }
  for (const ch of raw.channels) {
    if (!ch.id) throw new Error('Each channel must have an "id"');
    if (!ch.platform) throw new Error(`Channel "${ch.id}" missing "platform"`);
    if (!ch.workingDirectory) throw new Error(`Channel "${ch.id}" missing "workingDirectory"`);
    if (!raw.platforms[ch.platform]) {
      throw new Error(`Channel "${ch.id}" references unknown platform "${ch.platform}"`);
    }
    // Validate bot reference if multi-bot
    const plat = raw.platforms[ch.platform];
    if (ch.bot && plat.bots && !plat.bots[ch.bot]) {
      throw new Error(`Channel "${ch.id}" references unknown bot "${ch.bot}" (available: ${Object.keys(plat.bots).join(', ')})`);
    }
    if (!fs.existsSync(ch.workingDirectory)) {
      console.warn(`Warning: workingDirectory "${ch.workingDirectory}" for channel "${ch.id}" does not exist`);
    }
  }
  
  // Apply defaults
  const defaults = {
    model: 'claude-sonnet-4.6',
    agent: null,
    triggerMode: 'mention' as const,
    threadedReplies: true,
    verbose: false,
    permissionMode: 'interactive' as const,
    ...raw.defaults,
  };
  
  _config = {
    platforms: raw.platforms,
    channels: raw.channels,
    defaults,
  };
  
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function getChannelConfig(channelId: string): ChannelConfig & { permissionMode: string } {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) throw new Error(`No config found for channel "${channelId}"`);
  
  // Resolve agent: channel-level overrides bot-level default
  const botConfig = getChannelBotConfig(channelId);
  const resolvedAgent = channel.agent !== undefined ? channel.agent
    : botConfig?.agent !== undefined ? botConfig.agent
    : config.defaults.agent;

  return {
    ...channel,
    model: channel.model ?? config.defaults.model,
    agent: resolvedAgent,
    triggerMode: channel.triggerMode ?? config.defaults.triggerMode,
    threadedReplies: channel.threadedReplies ?? config.defaults.threadedReplies,
    verbose: channel.verbose ?? config.defaults.verbose,
    permissionMode: config.defaults.permissionMode,
  };
}

/** Check if a channel ID is in our configured channels list */
export function isConfiguredChannel(channelId: string): boolean {
  const config = getConfig();
  return config.channels.some(c => c.id === channelId);
}

/**
 * Get the resolved bot token for a channel.
 * Supports both single-bot (botToken) and multi-bot (bots map) configs.
 */
export function getChannelBotToken(channelId: string): string {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) throw new Error(`No config found for channel "${channelId}"`);

  const platform = config.platforms[channel.platform];
  if (channel.bot && platform.bots?.[channel.bot]) {
    return platform.bots[channel.bot].token;
  }
  if (platform.botToken) return platform.botToken;
  // Multi-bot without channel.bot specified: use first bot
  if (platform.bots) {
    const first = Object.values(platform.bots)[0];
    if (first) return first.token;
  }
  throw new Error(`No bot token resolved for channel "${channelId}"`);
}

/** Get the BotConfig for a channel (if multi-bot). */
export function getChannelBotConfig(channelId: string): BotConfig | null {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) return null;
  const platform = config.platforms[channel.platform];
  if (channel.bot && platform.bots?.[channel.bot]) {
    return platform.bots[channel.bot];
  }
  return null;
}

/**
 * Get all unique bot tokens for a platform, keyed by bot name.
 * For single-bot configs, returns { "default": token }.
 */
export function getPlatformBots(platformName: string): Map<string, { token: string; agent?: string | null }> {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (!platform) throw new Error(`Unknown platform "${platformName}"`);

  const bots = new Map<string, { token: string; agent?: string | null }>();
  if (platform.bots) {
    for (const [name, bot] of Object.entries(platform.bots)) {
      bots.set(name, { token: bot.token, agent: bot.agent });
    }
  } else if (platform.botToken) {
    bots.set('default', { token: platform.botToken });
  }
  return bots;
}

/** Get the bot name a channel uses. */
export function getChannelBotName(channelId: string): string {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) return 'default';
  if (channel.bot) return channel.bot;
  const platform = config.platforms[channel.platform];
  if (platform.bots) return Object.keys(platform.bots)[0] ?? 'default';
  return 'default';
}
