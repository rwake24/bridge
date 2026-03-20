#!/usr/bin/env npx tsx
/**
 * agent0 init — Interactive setup wizard.
 *
 * Usage: npm run init
 *        npx tsx scripts/init.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { heading, success, warn, fail, info, dim, blank, printCheck } from './lib/output.js';
import { askRequired, askSecret, ask, confirm, choose, pressEnter, closePrompts } from './lib/prompts.js';
import { runAllPrereqs, checkNodeVersion } from './lib/prerequisites.js';
import { pingServer, validateBotToken, checkChannelAccess, getChannelInfo, getMyTeams, getChannelByTeamAndName, createMattermostChannel, addBotToChannel, AGENT0_CHANNELS, type MattermostBotInfo } from './lib/mattermost.js';
import { buildConfig, writeConfig, configExists, getConfigPath, getConfigDir, readExistingConfig, mergeConfig, type BotEntry, type ChannelEntry, type ConfigDefaults } from './lib/config-gen.js';
import { generateManifestUrl, validateSlackToken, validateAppToken, resolveSlackUser } from './lib/slack.js';
import { detectPlatform, getServiceStatus } from './lib/service.js';

async function promptAllowlist(botName: string): Promise<{ mode: 'allowlist'; users: string[] } | undefined> {
  info(`\nAccess control: who can use "${botName}"?`);
  dim('By default, only users you list here can interact with this bot.\n');

  let yourHandle = await askRequired('Your username (you\'ll be added to the allowlist)');
  yourHandle = yourHandle.replace(/^@/, '').trim();
  const users = [yourHandle];

  const extra = await confirm('Add more users to the allowlist?', false);
  if (extra) {
    const moreRaw = await askRequired('Additional usernames (comma-separated)');
    for (const u of moreRaw.split(',')) {
      const trimmed = u.replace(/^@/, '').trim();
      if (trimmed.length > 0) users.push(trimmed);
    }
  }

  success(`Allowlist: ${users.join(', ')}`);
  return { mode: 'allowlist', users };
}

/**
 * Try to store a secret in the OS keychain via keytar.
 * Returns true if stored successfully, false if keytar is unavailable.
 */
async function storeInKeychain(service: string, account: string, password: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    await keytar.setPassword(service, account, password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to read a secret from the OS keychain via keytar.
 * Returns the secret or null if unavailable/not found.
 */
async function readFromKeychain(service: string, account: string): Promise<string | null> {
  try {
    const keytar = await import('keytar');
    return await keytar.getPassword(service, account);
  } catch {
    return null;
  }
}

async function main() {
  const isCli = process.env.COPILOT_BRIDGE_CLI === '1';
  console.log();
  heading('🚀 agent0 setup');
  dim('Interactive wizard to configure agent0.\n');

  // --- Step 1: Prerequisites ---
  heading('Step 1: Prerequisites');

  const nodeCheck = checkNodeVersion();
  printCheck(nodeCheck);
  if (nodeCheck.status === 'fail') {
    fail('Node.js 20+ is required. Please upgrade and re-run.');
    process.exit(1);
  }

  const prereqs = runAllPrereqs();
  // Skip node (already printed); print Copilot CLI and auth
  for (const check of prereqs.slice(1)) {
    printCheck(check);
  }

  const hasFail = prereqs.some(c => c.status === 'fail');
  if (hasFail) {
    blank();
    warn('Some prerequisites failed. You can continue setup, but the bridge may not work until they are resolved.');
    if (!await confirm('Continue anyway?', false)) {
      process.exit(1);
    }
  }

  // --- Check for existing config ---
  let existingConfig = configExists() ? readExistingConfig() : null;
  let mergeMode = false;

  if (existingConfig) {
    blank();
    warn(`Existing config found at ${getConfigPath()}`);
    const existingPlatforms = Object.keys(existingConfig.platforms ?? {});
    info(`Current platforms: ${existingPlatforms.join(', ') || 'none'}`);

    const action = await choose('What would you like to do?', [
      'Add a platform (keep existing config)',
      'Start fresh (overwrite)',
      'Cancel',
    ]);

    if (action === 2) {
      info(isCli
        ? 'Run "copilot-bridge check" to validate your existing config.'
        : 'Run "npm run check" to validate your existing config.');
      closePrompts();
      process.exit(0);
    }
    mergeMode = action === 0;
    if (!mergeMode) existingConfig = null;
  }

  // --- Step 2: Platform selection ---
  heading('Step 2: Platform');

  let useMattermost = false;
  let useSlack = false;

  if (mergeMode && existingConfig) {
    // In merge mode, only offer platforms not yet configured
    const hasMattermost = !!existingConfig.platforms?.mattermost;
    const hasSlack = !!existingConfig.platforms?.slack;
    const available: string[] = [];
    if (!hasMattermost) available.push('Mattermost');
    if (!hasSlack) available.push('Slack');

    if (available.length === 0) {
      info('Both platforms are already configured.');
      closePrompts();
      process.exit(0);
    } else if (available.length === 1) {
      info(`Adding ${available[0]} to your existing config.`);
      useMattermost = available[0] === 'Mattermost';
      useSlack = available[0] === 'Slack';
    } else {
      const idx = await choose('Which platform to add?', [...available, 'Both']);
      if (idx === available.length) {
        useMattermost = true;
        useSlack = true;
      } else {
        useMattermost = available[idx] === 'Mattermost';
        useSlack = available[idx] === 'Slack';
      }
    }
  } else {
    const platformChoice = await choose('Which chat platform(s)?', [
      'Mattermost',
      'Slack',
      'Both',
    ]);
    useMattermost = platformChoice === 0 || platformChoice === 2;
    useSlack = platformChoice === 1 || platformChoice === 2;
  }

  // --- Step 3: Platform-specific setup ---
  let mmUrl = '';
  const bots: BotEntry[] = [];
  const slackBots: BotEntry[] = [];
  const channels: ChannelEntry[] = [];

  // ── Mattermost ──────────────────────────────────────────
  if (useMattermost) {
    heading('Step 3a: Mattermost Connection');
    info('Connect to your Mattermost instance. You\'ll need the URL and a bot token.');
    dim('Create bot accounts in Mattermost: System Console → Integrations → Bot Accounts\n');

    while (true) {
      mmUrl = await askRequired('Mattermost URL (e.g., https://chat.example.com)');
      mmUrl = mmUrl.replace(/\/+$/, '');
      if (!mmUrl.startsWith('http')) mmUrl = `https://${mmUrl}`;

      const ping = await pingServer(mmUrl);
      printCheck(ping);
      if (ping.status === 'pass' || ping.status === 'warn') break;
      if (!await confirm('Try a different URL?')) {
        warn('Continuing with unverified URL.');
        break;
      }
    }

    heading('Mattermost Bots');
    let addMore = true;
    while (addMore) {
      if (bots.length === 0) {
        info('Enter the bot token from your Mattermost bot account.');
        dim('You can add more bots later if you want multiple identities.\n');
      }

      const token = await askSecret(`Bot token${bots.length > 0 ? ' (for next bot)' : ''}`);
      const validation = await validateBotToken(mmUrl, token);
      printCheck(validation.result);

      if (validation.result.status === 'pass' && validation.bot) {
        const isAdmin = validation.bot.roles?.includes('system_admin')
          || await confirm(`Is "${validation.bot.username}" an admin bot?`, false);

        bots.push({
          name: validation.bot.username,
          token,
          admin: !!isAdmin,
        });
        success(`Added bot "${validation.bot.username}"${isAdmin ? ' (admin)' : ''}`);
        const access = await promptAllowlist(validation.bot.username);
        if (access) bots[bots.length - 1].access = access;
      } else {
        warn(isCli
          ? 'Token validation failed. The token was still added — verify it later with "copilot-bridge check".'
          : 'Token validation failed. The token was still added — verify it later with "npm run check".');
        let name = await askRequired('Bot username (for config)');
        name = name.replace(/^@/, '');
        bots.push({ name, token, admin: false });
        const access = await promptAllowlist(name);
        if (access) bots[bots.length - 1].access = access;
      }

      if (bots.length >= 1) {
        addMore = await confirm('Add another bot?', false);
      }
    }

    // Auto-create agent0 channel structure
    heading('Mattermost Channel Structure');
    info('agent0 uses dedicated channels for briefings, tasks, logs, and more.');
    dim(`Channels: ${AGENT0_CHANNELS.map(c => c.name).join(', ')}\n`);

    let autoCreatedBotInfo: MattermostBotInfo | undefined;
    // Prefer the admin bot for channel creation; fall back to the first bot
    const adminBot = bots.find(b => b.admin) ?? bots[0];

    // Re-validate to capture bot ID for membership operations
    const botValidation = await validateBotToken(mmUrl, adminBot.token);
    if (botValidation.result.status === 'pass' && botValidation.bot) {
      autoCreatedBotInfo = botValidation.bot;
    }

    const autoCreate = await confirm('Auto-create these channels in Mattermost now?', true);
    if (autoCreate && autoCreatedBotInfo) {
      // Select team
      const teams = await getMyTeams(mmUrl, adminBot.token);
      let selectedTeamId: string | undefined;
      if (teams.length === 0) {
        warn('No teams found for this bot — skipping auto-create.');
      } else if (teams.length === 1) {
        selectedTeamId = teams[0].id;
        info(`Using team: ${teams[0].displayName || teams[0].name}`);
      } else {
        const teamIdx = await choose('Which team should the channels be created in?', teams.map(t => t.displayName || t.name));
        selectedTeamId = teams[teamIdx].id;
      }

      if (selectedTeamId) {
        const workspacesDir = path.join(getConfigDir(), 'workspaces');
        let botForChannels = bots[0].name;
        if (bots.length > 1) {
          const idx = await choose('Which bot should be assigned to these channels?', bots.map(b => b.name));
          botForChannels = bots[idx].name;
        }

        blank();
        for (const def of AGENT0_CHANNELS) {
          // Check if the channel already exists
          const existing = await getChannelByTeamAndName(mmUrl, adminBot.token, selectedTeamId, def.name);
          let channelId: string | undefined;

          if (existing) {
            printCheck({ status: 'warn', label: `#${def.name}`, detail: 'already exists — skipping creation' });
            channelId = existing.id;
          } else {
            const { result, channel } = await createMattermostChannel(mmUrl, adminBot.token, {
              teamId: selectedTeamId,
              name: def.name,
              displayName: def.displayName,
              purpose: def.purpose,
              header: def.header,
            });
            printCheck(result);
            channelId = channel?.id;
          }

          if (channelId) {
            // Ensure the bot is a member
            if (autoCreatedBotInfo.id) {
              const memberResult = await addBotToChannel(mmUrl, adminBot.token, channelId, autoCreatedBotInfo.id);
              if (memberResult.status !== 'pass') {
                printCheck(memberResult);
              }
            }

            // Create the workspace directory for this channel
            const workDir = path.join(workspacesDir, def.name);
            if (!fs.existsSync(workDir)) {
              fs.mkdirSync(workDir, { recursive: true });
            }

            channels.push({
              id: channelId,
              name: def.displayName,
              platform: 'mattermost',
              bot: botForChannels,
              workingDirectory: workDir,
              triggerMode: 'mention',
              threadedReplies: false,
            });
          }
        }
        blank();
        success(`Created/verified ${AGENT0_CHANNELS.length} agent0 channels.`);
      }
    } else if (autoCreate && !autoCreatedBotInfo) {
      warn('Could not retrieve bot identity — skipping auto-create. Re-run after verifying the bot token.');
    }

    // Mattermost channels
    heading('Mattermost Channels');
    info('Direct messages work automatically — no config needed.');
    info('Group channels need their channel ID and a working directory.\n');

    let addChannels = await confirm('Configure group channels now?', false);
    while (addChannels) {
      const channelId = await askRequired('Channel ID (from Mattermost channel settings → View Info)');

      const primaryBot = bots[0];
      const access = await checkChannelAccess(mmUrl, primaryBot.token, channelId);
      printCheck(access);

      let channelName: string | undefined;
      if (access.status === 'pass') {
        const chInfo = await getChannelInfo(mmUrl, primaryBot.token, channelId);
        channelName = chInfo?.displayName || chInfo?.name;
      }

      const workDir = await askRequired('Working directory (absolute path for this channel\'s workspace)');
      if (!fs.existsSync(workDir)) {
        if (await confirm(`Directory "${workDir}" doesn't exist. Create it?`)) {
          fs.mkdirSync(workDir, { recursive: true });
          success(`Created ${workDir}`);
        }
      }

      let botName = bots[0].name;
      if (bots.length > 1) {
        const idx = await choose('Which bot for this channel?', bots.map(b => b.name));
        botName = bots[idx].name;
      }

      const triggerIdx = await choose('Trigger mode for this channel?', [
        'mention — respond only when @mentioned (recommended)',
        'all — respond to every message',
      ]);
      const triggerMode = triggerIdx === 0 ? 'mention' as const : 'all' as const;
      const threadedReplies = await confirm('Reply in threads?', true);

      channels.push({
        id: channelId,
        name: channelName,
        platform: 'mattermost',
        bot: botName,
        workingDirectory: workDir,
        triggerMode,
        threadedReplies,
      });
      success(`Added channel${channelName ? ` "${channelName}"` : ''}`);
      addChannels = await confirm('Add another channel?', false);
    }

    if (channels.length === 0) {
      info('No group channels configured. DMs will still work automatically.');
    }
  }

  // ── Slack ───────────────────────────────────────────────
  if (useSlack) {
    heading(useMattermost ? 'Step 3b: Slack Connection' : 'Step 3: Slack Connection');
    info('We\'ll create a Slack app with the right permissions via a manifest URL.');
    blank();

    const botDisplayName = await askRequired('Bot display name for Slack (e.g., copilot)');
    const manifestUrl = generateManifestUrl(botDisplayName);

    info('Open this URL in your browser to create the Slack app:');
    blank();
    console.log(`  ${manifestUrl}`);
    blank();
    dim('Steps in Slack:');
    dim('  1. Click the link above → review the manifest → Create');
    dim('  2. On the app page, go to "OAuth & Permissions" → Install to Workspace');
    dim('  3. Copy the "Bot User OAuth Token" (starts with xoxb-)');
    dim('  4. Go to "Basic Information" → "App-Level Tokens" → Generate Token');
    dim('     Name it anything, add the "connections:write" scope, then Generate');
    dim('  5. Copy the app-level token (starts with xapp-)');
    blank();

    await pressEnter('Press Enter when you\'re ready to paste the tokens...');

    // Bot token
    const botToken = await askSecret('Bot User OAuth Token (xoxb-...)');
    const tokenResult = await validateSlackToken(botToken);
    if (tokenResult.ok) {
      success(`Authenticated as @${tokenResult.botName} in ${tokenResult.teamName}`);
    } else {
      warn(`Token validation failed: ${tokenResult.error}. Added anyway — verify later.`);
    }

    // App token
    const appToken = await askSecret('App-Level Token (xapp-...)');
    const appResult = await validateAppToken(appToken);
    if (appResult.ok) {
      success('Socket Mode connection verified');
    } else {
      warn(`App token validation failed: ${appResult.error}. Added anyway — verify later.`);
    }

    const slackBotName = tokenResult.botName ?? botDisplayName;
    const isAdmin = await confirm(`Is "${slackBotName}" an admin bot?`, false);

    slackBots.push({
      name: slackBotName,
      token: botToken,
      appToken,
      admin: isAdmin,
    });
    success(`Added Slack bot "${slackBotName}"${isAdmin ? ' (admin)' : ''}`);

    // Allowlist — resolve Slack handles to UIDs
    const access = await promptAllowlist(slackBotName);
    if (access) {
      const resolvedUsers: string[] = [];
      for (const handle of access.users) {
        const result = await resolveSlackUser(botToken, handle);
        if (result.userId) {
          success(`  Resolved "${handle}" → ${result.userId}${result.displayName ? ` (${result.displayName})` : ''}`);
          resolvedUsers.push(result.userId);
        } else {
          warn(`  Could not resolve "${handle}"${result.error ? `: ${result.error}` : ''} — storing as-is`);
          resolvedUsers.push(handle);
        }
      }
      slackBots[slackBots.length - 1].access = { mode: 'allowlist', users: resolvedUsers };
    }
    // Slack channels (DMs auto-discovered, channels optional)
    blank();
    info('Slack DMs work automatically. You can optionally configure specific channels.');
    let addSlackChannels = await confirm('Configure Slack channels now?', false);
    while (addSlackChannels) {
      const channelId = await askRequired('Slack channel ID (right-click channel → View channel details → copy ID at bottom)');
      const workDir = await askRequired('Working directory (absolute path for this channel\'s workspace)');
      if (!fs.existsSync(workDir)) {
        if (await confirm(`Directory "${workDir}" doesn't exist. Create it?`)) {
          fs.mkdirSync(workDir, { recursive: true });
          success(`Created ${workDir}`);
        }
      }

      const triggerIdx = await choose('Trigger mode for this channel?', [
        'mention — respond only when @mentioned (recommended)',
        'all — respond to every message',
      ]);
      const triggerMode = triggerIdx === 0 ? 'mention' as const : 'all' as const;
      const threadedReplies = await confirm('Reply in threads?', true);

      channels.push({
        id: channelId,
        platform: 'slack',
        bot: slackBotName,
        workingDirectory: workDir,
        triggerMode,
        threadedReplies,
      });
      success('Added Slack channel');
      addSlackChannels = await confirm('Add another Slack channel?', false);
    }
  }

  // --- Step 4: GitHub PAT (optional) ---
  if (!mergeMode) {
    heading('Step 4: GitHub Personal Access Token (Optional)');
    info('A GitHub PAT allows agent0 to make authenticated GitHub API calls.');
    dim('Scopes needed: repo, read:org (or adjust for your use case)\n');

    const storePat = await confirm('Store a GitHub Personal Access Token now?', false);
    if (storePat) {
      const pat = await askSecret('GitHub PAT (ghp_... or github_pat_...)');
      if (pat) {
        // Try OS keychain first, fall back to file
        const keychainOk = await storeInKeychain('agent0', 'github-pat', pat);
        if (keychainOk) {
          success('GitHub PAT stored in OS keychain (service: agent0, account: github-pat)');
        } else {
          // Fall back: write to a restricted file
          const patFile = path.join(getConfigDir(), '.github-pat');
          const dir = path.dirname(patFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(patFile, pat, { mode: 0o600, encoding: 'utf-8' });
          success(`GitHub PAT saved to ${patFile} (permissions: 600)`);
          warn('keytar (OS keychain) not available — PAT stored in a file. Keep it secure.');
        }
      }
    } else {
      dim('Skipped — you can set GITHUB_TOKEN in your environment or run the wizard again.\n');
    }
  }

  // --- Step 5: Defaults (skip in merge mode — existing config has them) ---
  const defaults: ConfigDefaults = {};

  if (!mergeMode) {
    heading('Step 5: Defaults');
    dim('These can be changed later in config.json or via chat commands.\n');

    const modelChoice = await choose('Default model?', [
      'claude-sonnet-4.6 (recommended)',
      'claude-opus-4.6 (premium)',
      'claude-haiku-4.5 (fast/cheap)',
      'Other (enter manually)',
    ]);
    if (modelChoice === 3) {
      defaults.model = await askRequired('Model name');
    } else {
      defaults.model = ['claude-sonnet-4.6', 'claude-opus-4.6', 'claude-haiku-4.5'][modelChoice];
    }

    const triggerChoice = await choose('Default trigger mode (for group channels — DMs always respond)?', [
      'mention — bot responds only when @mentioned (recommended)',
      'all — bot responds to every message in the channel',
    ]);
    defaults.triggerMode = triggerChoice === 0 ? 'mention' : 'all';
    defaults.threadedReplies = await confirm('Reply in threads by default?', true);
    defaults.verbose = await confirm('Verbose mode (show tool calls)?', false);

    // Permission mode
    blank();
    info('Default permission mode — controls how agent0 handles tool use:');
    dim('  interactive  — asks before each tool use (most secure, default)');
    dim('  auto-approve — approves all tool calls automatically (personal/trusted setups)');
    dim('  allowlist    — auto-approve only allowed tools, prompt for others');
    dim('  You can change this later with /yolo or /autopilot in chat.\n');
    const permChoice = await choose('Default permission mode?', [
      'interactive (recommended) — prompt for each tool use',
      'auto-approve — allow all tool calls automatically',
      'allowlist — allow specific tools, prompt for others',
    ]);
    defaults.permissionMode = (['interactive', 'auto-approve', 'allowlist'] as const)[permChoice];
  }

  // --- Step 6: MCP Servers (Optional) ---
  heading('Step 6: MCP Servers (Optional)');
  info('MCP (Model Context Protocol) servers extend agent0 with external tools and APIs.');

  const mcpConfigPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  dim(`Configured servers are loaded from ${mcpConfigPath}\n`);
  let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };

  if (fs.existsSync(mcpConfigPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      if (existing.mcpServers && typeof existing.mcpServers === 'object') {
        mcpConfig = existing;
        const serverNames = Object.keys(mcpConfig.mcpServers);
        if (serverNames.length > 0) {
          info(`Existing MCP servers: ${serverNames.join(', ')}`);
        }
      }
    } catch {
      warn('Could not read existing mcp-config.json — will create a new one if you add servers.');
    }
  }

  const addMcp = await confirm('Configure MCP servers now?', false);
  if (addMcp) {
    let addingServers = true;
    while (addingServers) {
      const serverTypeChoice = await choose('Add MCP server:', [
        'WorkIQ (pre-configured template)',
        'Custom (enter command manually)',
        'Done — no more servers',
      ]);

      if (serverTypeChoice === 2) {
        addingServers = false;
      } else if (serverTypeChoice === 0) {
        // WorkIQ template
        const workiqUrl = await ask('WorkIQ server URL', 'http://localhost:3000');
        const workiqKey = await ask('WorkIQ API key (leave blank to skip)');
        mcpConfig.mcpServers['workiq'] = {
          command: 'npx',
          args: ['-y', '@workiq/mcp-server', '--url', workiqUrl || 'http://localhost:3000'],
          ...(workiqKey ? { env: { WORKIQ_API_KEY: workiqKey } } : {}),
        };
        success('Added WorkIQ MCP server');
      } else {
        // Custom server
        const serverName = await askRequired('Server name (e.g., my-server)');
        const command = await askRequired('Command (e.g., npx, python, /usr/local/bin/server)');
        const argsRaw = await ask('Arguments (space-separated, no quoting; leave blank for none)');
        const args = argsRaw ? argsRaw.trim().split(/\s+/) : [];
        mcpConfig.mcpServers[serverName] = {
          command,
          ...(args.length > 0 ? { args } : {}),
        };
        success(`Added MCP server "${serverName}"`);
      }

      if (addingServers) {
        addingServers = await confirm('Add another MCP server?', false);
      }
    }

    if (Object.keys(mcpConfig.mcpServers).length > 0) {
      const copilotDir = path.join(os.homedir(), '.copilot');
      if (!fs.existsSync(copilotDir)) fs.mkdirSync(copilotDir, { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
      success(`MCP config written to ${mcpConfigPath}`);
    }
  } else {
    dim('Skipped — add MCP servers later by editing ~/.copilot/mcp-config.json\n');
  }

  // --- Step 7: Generate config ---
  heading('Step 7: Generate Config');

  let finalConfig = buildConfig({ mmUrl: mmUrl || undefined, bots, channels, defaults, slackBots });

  // Merge with existing config if in merge mode
  if (mergeMode && existingConfig) {
    finalConfig = mergeConfig(existingConfig, finalConfig);
    info('Merged new platform into existing config.');
  }

  if (configExists()) {
    dim('Backing up existing config before writing...');
  }
  const configPath = writeConfig(finalConfig);
  success(`Config written to ${configPath}`);

  // Ensure workspaces dir exists
  const workspacesDir = path.join(getConfigDir(), 'workspaces');
  if (!fs.existsSync(workspacesDir)) {
    fs.mkdirSync(workspacesDir, { recursive: true });
  }

  // --- Step 8: Service Setup (Optional) ---
  heading('Step 8: Service Setup (Optional)');

  const osPlatform = detectPlatform();
  if (osPlatform === 'macos') {
    info('To run as a launchd service (auto-start at login):');
    dim(isCli ? '  agent0 install-service\n' : '  npm run install-service\n');
  } else if (osPlatform === 'linux') {
    info('To run as a systemd service (auto-start at boot):');
    dim(isCli ? '  agent0 install-service' : '  npm run install-service');
    dim('  (requires sudo — installs to /etc/systemd/system/)\n');
    if (!isCli) dim('  Note: build first with npm run build\n');
  } else {
    info(isCli
      ? 'Run the bridge manually: agent0 start'
      : 'Run the bridge manually: npm run dev (development) or npm start (production)');
  }

  // --- Done ---
  heading('✅ Setup Complete');
  blank();
  info(`Config: ${configPath}`);
  const allBotNames = [...bots.map(b => b.name), ...slackBots.map(b => b.name)];
  info(`Bots: ${allBotNames.join(', ')}`);
  const platforms = [useMattermost ? 'Mattermost' : null, useSlack ? 'Slack' : null].filter(Boolean);
  info(`Platforms: ${platforms.join(', ')}`);
  if (channels.length > 0) info(`Channels: ${channels.length} configured`);
  info('DMs: enabled automatically');
  blank();

  const showNextSteps = () => {
    dim('Next steps:');
    if (isCli) {
      dim('  agent0 check            Validate your setup');
      dim('  agent0 start            Start the bridge');
      dim('  agent0 install-service  Install as a system service');
    } else {
      dim('  npm run dev              Start in development mode (watch)');
      dim('  npm run check            Validate your setup');
      dim('  npm run install-service  Install as a system service');
      dim('  npm run build            Build for production');
      dim('  npm start                Start production server');
    }
    blank();
  };

  // Detect running service and suggest restart
  const serviceStatus = getServiceStatus();
  if (serviceStatus.running) {
    warn('The bridge service is currently running. Restart it to apply the new config:');
    if (osPlatform === 'macos') {
      dim('  launchctl kickstart -k gui/$(id -u)/com.copilot-bridge');
    } else if (osPlatform === 'linux') {
      dim('  sudo systemctl restart copilot-bridge');
    }
    blank();
  } else if (serviceStatus.running === false && serviceStatus.pid !== undefined || serviceStatus.detail.startsWith('launchd:') || serviceStatus.detail.startsWith('systemd:')) {
    // Service is known to the OS but not running
    if (serviceStatus.detail.includes('not installed') || serviceStatus.detail.includes('not loaded')) {
      // Not actually installed — show normal next steps
      showNextSteps();
    } else {
      info('The bridge service is installed but not running. Start it with:');
      if (osPlatform === 'macos') {
        dim('  launchctl kickstart gui/$(id -u)/com.copilot-bridge');
      } else if (osPlatform === 'linux') {
        dim('  sudo systemctl start copilot-bridge');
      }
      blank();
    }
  } else {
    showNextSteps();
  }

  closePrompts();
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message || err);
  closePrompts();
  process.exit(1);
});
