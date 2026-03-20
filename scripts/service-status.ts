#!/usr/bin/env npx tsx
/**
 * bridge service-status — Show the current service status.
 *
 * macOS:   launchctl list com.bridge
 * Linux:   systemctl is-active bridge
 * Windows: sc.exe query Bridge / Get-Service
 *
 * Usage: bridge service-status
 */

import { heading, success, fail, info, dim, blank } from './lib/output.js';
import { detectPlatform, getServiceStatus, getLogPath, getWindowsLogPath } from './lib/service.js';
import * as os from 'node:os';

function main() {
  const osPlatform = detectPlatform();

  heading('ℹ️  Bridge service status');
  blank();

  const status = getServiceStatus();

  if (status.running) {
    success(`Running — ${status.detail}`);
  } else {
    fail(`Not running — ${status.detail}`);
  }

  blank();
  dim('Logs:');

  if (osPlatform === 'macos') {
    const logPath = getLogPath(os.homedir());
    dim(`  tail -f "${logPath}"`);
  } else if (osPlatform === 'linux') {
    dim('  sudo journalctl -u bridge -f');
  } else if (osPlatform === 'windows') {
    const logPath = getWindowsLogPath(os.homedir());
    dim(`  Get-Content -Wait "${logPath}"   # PowerShell`);
  } else {
    info('Service management is not supported on this platform.');
  }

  blank();
  dim('Management:');
  dim('  bridge service-start      # start the service');
  dim('  bridge service-stop       # stop the service');
  dim('  bridge install-service    # install (if not installed)');
  dim('  bridge uninstall-service  # remove the service');
}

main();
