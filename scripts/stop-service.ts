#!/usr/bin/env npx tsx
/**
 * bridge service-stop — Stop the running bridge service.
 *
 * macOS:   launchctl bootout gui/$(id -u)/com.bridge
 * Linux:   sudo systemctl stop bridge
 * Windows: sc.exe stop Bridge
 *
 * Usage: bridge service-stop
 */

import { heading, success, fail, info, blank } from './lib/output.js';
import { detectPlatform, getLaunchdInstallPath, stopWindowsService } from './lib/service.js';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

function main() {
  const osPlatform = detectPlatform();

  heading('⏹️  Bridge service stop');
  blank();

  if (osPlatform === 'macos') {
    const plistPath = getLaunchdInstallPath();
    if (!fs.existsSync(plistPath)) {
      fail('No launchd service found. Run "bridge install-service" first.');
      process.exit(1);
    }
    try {
      execSync(
        'launchctl bootout gui/$(id -u)/com.bridge 2>/dev/null || launchctl unload "' +
          getLaunchdInstallPath() +
          '" 2>/dev/null',
        { stdio: 'inherit' },
      );
      blank();
      success('Service stopped.');
    } catch {
      fail('Failed to stop service. It may not be running.');
      process.exit(1);
    }

  } else if (osPlatform === 'linux') {
    try {
      execSync('sudo systemctl stop bridge', { stdio: 'inherit' });
      blank();
      success('Service stopped.');
    } catch {
      fail('Failed to stop service.');
      info('To diagnose: sudo systemctl status bridge');
      process.exit(1);
    }

  } else if (osPlatform === 'windows') {
    const result = stopWindowsService();
    if (result.stopped) {
      blank();
      success('Service stopped.');
    } else {
      fail(`Failed to stop service: ${result.error}`);
      info('Make sure you are running this command as Administrator.');
      info('To check service status: bridge service-status');
      process.exit(1);
    }

  } else {
    fail('Unsupported platform — cannot stop service.');
    process.exit(1);
  }
}

main();
