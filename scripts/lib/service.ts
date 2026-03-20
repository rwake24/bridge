/**
 * OS-specific service file generation and installation.
 * Supports macOS (launchd), Linux (systemd system-level units), and Windows (NSSM / sc.exe).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

export type Platform = 'macos' | 'linux' | 'windows' | 'unsupported';

export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return 'unsupported';
  }
}

export function getNodePath(): string {
  try {
    if (process.platform === 'win32') {
      return execSync('where node', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    }
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.platform === 'win32' ? 'node' : '/usr/local/bin/node';
  }
}

export function getSystemPath(): string {
  // Include the directory containing the current node binary (e.g., nvm paths)
  const nodeBinDir = path.dirname(getNodePath());
  const platform = detectPlatform();
  const basePath = platform === 'macos'
    ? '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  // Prepend node's bin dir if not already in the base path
  if (basePath.split(':').includes(nodeBinDir)) return basePath;
  return `${nodeBinDir}:${basePath}`;
}

export function getLogPath(homePath: string): string {
  return path.join(homePath, '.copilot-bridge', 'copilot-bridge.log');
}

// --- launchd (macOS) ---

export interface LaunchdConfig {
  label: string;
  bridgePath: string;
  homePath: string;
}

export function generateLaunchdPlist(config: LaunchdConfig): string {
  const nodePath = getNodePath();
  const tsxPath = path.join(config.bridgePath, 'node_modules', '.bin', 'tsx');
  const logPath = getLogPath(config.homePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${config.label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${tsxPath}</string>
        <string>dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${config.bridgePath}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${getSystemPath()}</string>
        <key>HOME</key>
        <string>${config.homePath}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>Umask</key>
    <integer>63</integer>

    <key>StandardOutPath</key>
    <string>${logPath}</string>

    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>`;
}

export function getLaunchdInstallPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.copilot-bridge.plist');
}

export function installLaunchd(plistContent: string): { installed: boolean; path: string; error?: string } {
  const installPath = getLaunchdInstallPath();
  try {
    const dir = path.dirname(installPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Unload existing service before overwriting (ignore errors if not loaded)
    try { execSync(`launchctl bootout gui/$(id -u) "${installPath}" 2>/dev/null`, { encoding: 'utf-8' }); } catch { /* not loaded */ }
    fs.writeFileSync(installPath, plistContent, 'utf-8');
    execSync(`launchctl load "${installPath}"`, { encoding: 'utf-8' });
    return { installed: true, path: installPath };
  } catch (err) {
    return { installed: false, path: installPath, error: String(err) };
  }
}

export function generateNewsyslogConfig(logPath: string, user: string): string {
  let group = 'staff';
  try { group = execSync('id -gn', { encoding: 'utf-8' }).trim(); } catch { /* default */ }
  // N=no signal, C=create new file after rotation, Z=gzip compress
  // Rotates at 10 MB, keeps 3 archives
  return `# Copilot Bridge log rotation — installed by copilot-bridge install-service
# logfilename  owner:group  mode  count  size(KB)  when  flags
${logPath}  ${user}:${group}  600  3  10240  *  NCZ
`;
}

export function getNewsyslogInstallPath(): string {
  return '/etc/newsyslog.d/copilot-bridge.conf';
}

// --- systemd (Linux) ---

export interface SystemdConfig {
  bridgePath: string;
  homePath: string;
  user: string;
}

export function generateSystemdUnit(config: SystemdConfig): string {
  const nodePath = getNodePath();
  const tsxPath = path.join(config.bridgePath, 'node_modules', '.bin', 'tsx');
  return `[Unit]
Description=Copilot Bridge
After=network.target

[Service]
Type=simple
User=${config.user}
ExecStart="${nodePath}" "${tsxPath}" "${config.bridgePath}/dist/index.js"
WorkingDirectory=${config.bridgePath}
Environment=HOME=${config.homePath}
Environment=PATH=${getSystemPath()}
Restart=always
RestartSec=10
UMask=0077

[Install]
WantedBy=multi-user.target`;
}

export function getSystemdInstallPath(): string {
  return '/etc/systemd/system/copilot-bridge.service';
}

// --- Windows (NSSM / sc.exe) ---

const WINDOWS_SERVICE_NAME = 'CopilotBridge';
const WINDOWS_SERVICE_DISPLAY = 'Copilot Bridge';
const WINDOWS_SERVICE_DESCRIPTION = 'Mattermost <-> GitHub Copilot bridge';

// --- Service status ---

export function getServiceStatus(): { running: boolean; pid?: number; detail: string } {
  const platform = detectPlatform();

  if (platform === 'macos') {
    try {
      const output = execSync('launchctl list com.copilot-bridge 2>/dev/null', { encoding: 'utf-8' });
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        return { running: true, pid: parseInt(pidMatch[1], 10), detail: `launchd, PID ${pidMatch[1]}` };
      }
      // launchctl list succeeded but no PID — service loaded but not running
      return { running: false, detail: 'launchd: loaded but not running' };
    } catch {
      return { running: false, detail: 'launchd: not loaded' };
    }
  }

  if (platform === 'linux') {
    try {
      // systemctl is-active exits non-zero for inactive/unknown services
      const output = execSync('systemctl is-active copilot-bridge 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (output === 'active') {
        try {
          const pid = execSync('systemctl show copilot-bridge --property=MainPID --value 2>/dev/null', { encoding: 'utf-8' }).trim();
          return { running: true, pid: parseInt(pid, 10), detail: `systemd, PID ${pid}` };
        } catch {
          return { running: true, detail: 'systemd: active' };
        }
      }
      return { running: false, detail: `systemd: ${output}` };
    } catch (err) {
      // Exit code 3 = inactive/dead (unit exists but not running)
      // Exit code 4 = no such unit file
      const stdout = err instanceof Error && 'stdout' in err ? String((err as { stdout: unknown }).stdout).trim() : '';
      if (stdout === 'inactive' || stdout === 'failed' || stdout === 'activating' || stdout === 'deactivating') {
        return { running: false, detail: `systemd: ${stdout}` };
      }
      return { running: false, detail: 'systemd: not installed' };
    }
  }

  if (platform === 'windows') {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "Get-Service -Name ${WINDOWS_SERVICE_NAME} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (output === 'Running') {
        try {
          const pid = execSync(
            `powershell -NoProfile -Command "(Get-WmiObject Win32_Service -Filter \\"Name='${WINDOWS_SERVICE_NAME}'\\" | Select-Object -ExpandProperty ProcessId)"`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
          return { running: true, pid: parseInt(pid, 10), detail: `Windows Service, PID ${pid}` };
        } catch {
          return { running: true, detail: 'Windows Service: Running' };
        }
      }
      if (output) return { running: false, detail: `Windows Service: ${output}` };
      return { running: false, detail: 'Windows Service: not installed' };
    } catch {
      return { running: false, detail: 'Windows Service: not installed' };
    }
  }

  return { running: false, detail: 'unsupported platform' };
}

// --- Windows service management ---

export interface WindowsServiceConfig {
  bridgePath: string;
  homePath: string;
}

/** Returns true when NSSM is found on PATH (preferred Windows service wrapper). */
export function isNssmAvailable(): boolean {
  try {
    execSync('where nssm', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function getWindowsServiceInstallPath(): string {
  // NSSM / sc.exe manage services by name; no file path needed.
  // Return a sentinel that callers can display.
  return `Windows Service: ${WINDOWS_SERVICE_NAME}`;
}

export function getWindowsLogPath(homePath: string): string {
  return path.join(homePath, '.copilot-bridge', 'copilot-bridge.log');
}

/** Run a command silently, ignoring errors (e.g., when removing a service that may not exist). */
function tryExecFileIgnore(file: string, args: string[]): void {
  try { execFileSync(file, args, { stdio: 'pipe' }); } catch { /* intentionally ignored */ }
}

/**
 * Install the bridge as a Windows service.
 *
 * Preferred path: NSSM (handles SCM protocol, auto-restart, log capture).
 * Fallback:       sc.exe + sc.exe failure (basic, no stdout capture).
 *
 * Both paths require an elevated (Administrator) shell.
 */
export function installWindowsService(
  config: WindowsServiceConfig,
): { installed: boolean; usedNssm: boolean; error?: string } {
  const nodePath = getNodePath();
  const scriptPath = path.join(config.bridgePath, 'dist', 'index.js');
  const logPath = getWindowsLogPath(config.homePath);

  // Ensure log directory exists
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  if (isNssmAvailable()) {
    try {
      // Remove stale service entry if present (ignore errors)
      tryExecFileIgnore('nssm', ['remove', WINDOWS_SERVICE_NAME, 'confirm']);

      execFileSync('nssm', ['install', WINDOWS_SERVICE_NAME, nodePath], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppParameters', scriptPath], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppDirectory', config.bridgePath], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'DisplayName', WINDOWS_SERVICE_DISPLAY], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'Description', WINDOWS_SERVICE_DESCRIPTION], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'Start', 'SERVICE_AUTO_START'], { stdio: 'pipe' });
      // Restart on failure: 10 s delay, reset counter after 1 day
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppRestartDelay', '10000'], { stdio: 'pipe' });
      // Log stdout + stderr to file
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppStdout', logPath], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppStderr', logPath], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppStdoutCreationDisposition', '4'], { stdio: 'pipe' });
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppStderrCreationDisposition', '4'], { stdio: 'pipe' });
      // Environment: HOME=<homePath>
      execFileSync('nssm', ['set', WINDOWS_SERVICE_NAME, 'AppEnvironmentExtra', `HOME=${config.homePath}`], { stdio: 'pipe' });
      execFileSync('nssm', ['start', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
      return { installed: true, usedNssm: true };
    } catch (err) {
      return { installed: false, usedNssm: true, error: String(err) };
    }
  }

  // Fallback: sc.exe (Node.js does not natively implement the SCM protocol,
  // so stop/restart may be abrupt — NSSM is strongly recommended).
  try {
    // Remove stale entry
    tryExecFileIgnore('sc.exe', ['delete', WINDOWS_SERVICE_NAME]);

    // Pass binPath via execFileSync so the shell never parses the embedded quotes.
    // sc.exe expects the full command as a single binPath= value with inner quotes.
    const binPath = `"${nodePath}" "${scriptPath}"`;
    execFileSync('sc.exe', [
      'create', WINDOWS_SERVICE_NAME,
      'binPath=', binPath,
      'DisplayName=', WINDOWS_SERVICE_DISPLAY,
      'start=', 'auto',
    ], { stdio: 'pipe' });
    execFileSync('sc.exe', ['description', WINDOWS_SERVICE_NAME, WINDOWS_SERVICE_DESCRIPTION], { stdio: 'pipe' });
    // Auto-restart: restart 3× (delays 10 s / 10 s / 30 s), reset after 1 day
    execFileSync('sc.exe', [
      'failure', WINDOWS_SERVICE_NAME,
      'reset=', '86400',
      'actions=', 'restart/10000/restart/10000/restart/30000',
    ], { stdio: 'pipe' });
    execFileSync('sc.exe', ['start', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
    return { installed: true, usedNssm: false };
  } catch (err) {
    return { installed: false, usedNssm: false, error: String(err) };
  }
}

/** Stop and delete the Windows service. */
export function uninstallWindowsService(): { uninstalled: boolean; error?: string } {
  if (isNssmAvailable()) {
    try {
      tryExecFileIgnore('nssm', ['stop', WINDOWS_SERVICE_NAME]);
      execFileSync('nssm', ['remove', WINDOWS_SERVICE_NAME, 'confirm'], { stdio: 'pipe' });
      return { uninstalled: true };
    } catch (err) {
      return { uninstalled: false, error: String(err) };
    }
  }

  try {
    tryExecFileIgnore('sc.exe', ['stop', WINDOWS_SERVICE_NAME]);
    execFileSync('sc.exe', ['delete', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
    return { uninstalled: true };
  } catch (err) {
    return { uninstalled: false, error: String(err) };
  }
}

/** Start the Windows service. */
export function startWindowsService(): { started: boolean; error?: string } {
  try {
    execFileSync('sc.exe', ['start', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
    return { started: true };
  } catch (err) {
    return { started: false, error: String(err) };
  }
}

/** Stop the Windows service. */
export function stopWindowsService(): { stopped: boolean; error?: string } {
  try {
    execFileSync('sc.exe', ['stop', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
    return { stopped: true };
  } catch (err) {
    return { stopped: false, error: String(err) };
  }
}
