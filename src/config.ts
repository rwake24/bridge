import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, ChannelConfig } from './types.js';

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
    if (!p.botToken) throw new Error(`Platform "${name}" missing "botToken"`);
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
  
  return {
    ...channel,
    model: channel.model ?? config.defaults.model,
    agent: channel.agent !== undefined ? channel.agent : config.defaults.agent,
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
