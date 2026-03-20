#!/usr/bin/env npx tsx
/**
 * bridge install-service — Install the bridge as a system service.
 *
 * macOS: installs a launchd plist (user-level, no sudo needed)
 * Linux: installs a systemd unit (system-level, requires sudo)
 *
 * Usage: npm run install-service
 *        npx tsx scripts/install-service.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { heading, success, fail, info, dim, blank } from './lib/output.js';
import {
  detectPlatform,
  generateLaunchdPlist, installLaunchd, getLaunchdInstallPath,
  generateSystemdUnit, getSystemdInstallPath,
  getLogPath, generateNewsyslogConfig, getNewsyslogInstallPath,
  installWindowsService, isNssmAvailable, getWindowsLogPath,
} from './lib/service.js';
import { execSync } from 'node:child_process';

function main() {
  const isCli = process.env.BRIDGE_CLI === '1';
  const osPlatform = detectPlatform();
  const bridgePath = process.cwd();
  const homePath = os.homedir();
  const user = os.userInfo().username;

  heading('📦 Bridge service installer');
  blank();

  if (osPlatform === 'macos') {
    info('macOS detected — installing launchd service.');
    dim('The service auto-starts at login and restarts on crash.\n');

    const distPath = path.join(bridgePath, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      fail(isCli
        ? 'dist/index.js not found. Package may be corrupted — try reinstalling.'
        : 'dist/index.js not found. Run "npm run build" first.');
      process.exit(1);
    }

    const plist = generateLaunchdPlist({
      label: 'com.bridge',
      bridgePath,
      homePath,
    });

    // Ensure log directory exists (launchd needs it before starting the process)
    const logDir = path.join(homePath, '.bridge');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(logDir, 0o700); } catch { /* best effort */ }

    const installPath = getLaunchdInstallPath();
    if (fs.existsSync(installPath)) {
      info(`Overwriting existing service at ${installPath}`);
    }

    const result = installLaunchd(plist);
    if (result.installed) {
      success(`Service installed at ${result.path}`);

      // Install log rotation via newsyslog
      const logPath = getLogPath(homePath);
      const newsyslogContent = generateNewsyslogConfig(logPath, user);
      const newsyslogPath = getNewsyslogInstallPath();
      try {
        execSync(`sudo tee "${newsyslogPath}" > /dev/null`, { input: newsyslogContent });
        success(`Log rotation installed at ${newsyslogPath}`);
      } catch {
        blank();
        dim('  ⚠️  Could not install log rotation (sudo required).');
        dim('  To install manually:');
        dim(`    sudo tee ${newsyslogPath} << 'EOF'`);
        dim(newsyslogContent.trimEnd());
        dim('    EOF');
      }

      // Migration: warn about old log file
      const oldLogPath = '/tmp/bridge.log';
      if (fs.existsSync(oldLogPath)) {
        blank();
        info(`📋 Log path changed: ${oldLogPath} → ${logPath}`);
        dim(`  You can delete the old log: rm ${oldLogPath}`);
      }

      blank();
      dim('Management:');
      dim('  launchctl list com.bridge                     # status');
      dim('  launchctl kickstart -k gui/$(id -u)/com.bridge  # restart');
      dim(`  tail -f ${getLogPath(homePath)}  # logs`);
    } else {
      fail(`Install failed: ${result.error}`);
      process.exit(1);
    }

  } else if (osPlatform === 'linux') {
    info('Linux detected — installing systemd service (system-scoped).');
    dim('The service starts at boot and restarts on crash.\n');

    const distPath = path.join(bridgePath, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      fail(isCli
        ? 'dist/index.js not found. Package may be corrupted — try reinstalling.'
        : 'dist/index.js not found. Run "npm run build" first.');
      process.exit(1);
    }

    const unit = generateSystemdUnit({ bridgePath, homePath, user });
    const installPath = getSystemdInstallPath();
    const tmpPath = path.join(os.tmpdir(), 'bridge.service');

    // Write to temp, then sudo copy
    fs.writeFileSync(tmpPath, unit, 'utf-8');

    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      info('This requires sudo to install to /etc/systemd/system/.');
      blank();
    }

    try {
      execSync(`sudo cp "${tmpPath}" "${installPath}"`, { stdio: 'inherit' });
      fs.unlinkSync(tmpPath);
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      execSync('sudo systemctl enable bridge', { stdio: 'inherit' });
      execSync('sudo systemctl start bridge', { stdio: 'inherit' });
      blank();
      success(`Service installed and started at ${installPath}`);
      blank();
      dim('Management:');
      dim('  sudo systemctl status bridge    # status');
      dim('  sudo systemctl restart bridge   # restart');
      dim('  sudo journalctl -u bridge -f    # logs');
    } catch {
      // sudo was denied or failed — leave temp file and show manual steps
      blank();
      fail('Automatic install failed (sudo may have been denied).');
      blank();
      info(`Service file written to: ${tmpPath}`);
      info('To install manually:');
      dim(`  sudo cp ${tmpPath} ${installPath}`);
      dim('  sudo systemctl daemon-reload');
      dim('  sudo systemctl enable --now bridge');
      process.exit(1);
    }

  } else if (osPlatform === 'windows') {
    info('Windows detected — installing Windows service.');
    if (isNssmAvailable()) {
      dim('Using NSSM for robust service management (auto-restart, log capture).\n');
    } else {
      dim('NSSM not found — falling back to sc.exe (basic mode).');
      dim('For better auto-restart and log capture, install NSSM: https://nssm.cc/\n');
    }

    const distPath = path.join(bridgePath, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      fail(isCli
        ? 'dist/index.js not found. Package may be corrupted — try reinstalling.'
        : 'dist/index.js not found. Run "npm run build" first.');
      process.exit(1);
    }

    const result = installWindowsService({ bridgePath, homePath });
    if (result.installed) {
      success(`Service installed and started (${result.usedNssm ? 'NSSM' : 'sc.exe'}).`);
      blank();
      const logPath = getWindowsLogPath(homePath);
      dim('Management:');
      dim('  bridge service-status    # status');
      dim('  bridge service-start     # start');
      dim('  bridge service-stop      # stop');
      if (result.usedNssm) {
        dim(`  Get-Content -Wait "${logPath}"      # logs (PowerShell)`);
      } else {
        dim('  sc.exe query Bridge           # status (sc.exe)');
      }
    } else {
      fail(`Install failed: ${result.error}`);
      blank();
      info('Make sure you are running this command as Administrator.');
      process.exit(1);
    }

  } else {
    fail('Unsupported platform for automatic service install.');
    info(isCli
      ? 'Run the bridge manually: bridge start'
      : 'Run the bridge manually: npm run dev (development) or npm start (production)');
    process.exit(1);
  }
}

main();
