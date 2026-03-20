#!/usr/bin/env npx tsx
/**
 * copilot-bridge service-start — Start the installed bridge service.
 *
 * macOS:   launchctl kickstart gui/$(id -u)/com.copilot-bridge
 * Linux:   sudo systemctl start copilot-bridge
 * Windows: sc.exe start CopilotBridge
 *
 * Usage: copilot-bridge service-start
 */

import { heading, success, fail, info, blank } from './lib/output.js';
import { detectPlatform, getLaunchdInstallPath, startWindowsService } from './lib/service.js';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

function main() {
  const osPlatform = detectPlatform();

  heading('▶️  copilot-bridge service start');
  blank();

  if (osPlatform === 'macos') {
    const plistPath = getLaunchdInstallPath();
    if (!fs.existsSync(plistPath)) {
      fail('No launchd service found. Run "copilot-bridge install-service" first.');
      process.exit(1);
    }
    try {
      execSync('launchctl kickstart gui/$(id -u)/com.copilot-bridge', { stdio: 'inherit' });
      blank();
      success('Service started.');
    } catch {
      fail('Failed to start service. It may already be running.');
      process.exit(1);
    }

  } else if (osPlatform === 'linux') {
    try {
      execSync('sudo systemctl start copilot-bridge', { stdio: 'inherit' });
      blank();
      success('Service started.');
    } catch {
      fail('Failed to start service.');
      info('To diagnose: sudo journalctl -u copilot-bridge -n 50');
      process.exit(1);
    }

  } else if (osPlatform === 'windows') {
    const result = startWindowsService();
    if (result.started) {
      blank();
      success('Service started.');
    } else {
      fail(`Failed to start service: ${result.error}`);
      info('Make sure you are running this command as Administrator.');
      info('To check service status: copilot-bridge service-status');
      process.exit(1);
    }

  } else {
    fail('Unsupported platform — cannot start service.');
    process.exit(1);
  }
}

main();
