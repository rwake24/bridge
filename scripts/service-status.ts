#!/usr/bin/env npx tsx
/**
 * copilot-bridge service-status — Show the current service status.
 *
 * macOS:   launchctl list com.copilot-bridge
 * Linux:   systemctl is-active copilot-bridge
 * Windows: sc.exe query CopilotBridge / Get-Service
 *
 * Usage: copilot-bridge service-status
 */

import { heading, success, fail, info, dim, blank } from './lib/output.js';
import { detectPlatform, getServiceStatus, getLogPath, getWindowsLogPath } from './lib/service.js';
import * as os from 'node:os';

function main() {
  const osPlatform = detectPlatform();

  heading('ℹ️  copilot-bridge service status');
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
    dim('  sudo journalctl -u copilot-bridge -f');
  } else if (osPlatform === 'windows') {
    const logPath = getWindowsLogPath(os.homedir());
    dim(`  Get-Content -Wait "${logPath}"   # PowerShell`);
  } else {
    info('Service management is not supported on this platform.');
  }

  blank();
  dim('Management:');
  dim('  copilot-bridge service-start      # start the service');
  dim('  copilot-bridge service-stop       # stop the service');
  dim('  copilot-bridge install-service    # install (if not installed)');
  dim('  copilot-bridge uninstall-service  # remove the service');
}

main();
