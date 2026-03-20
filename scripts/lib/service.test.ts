import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  getNodePath,
  generateLaunchdPlist,
  generateSystemdUnit,
  getLaunchdInstallPath,
  getSystemdInstallPath,
  getLogPath,
  generateNewsyslogConfig,
  getNewsyslogInstallPath,
  getWindowsLogPath,
  isNssmAvailable,
} from './service.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('service', () => {
  describe('detectPlatform', () => {
    it('returns macos, linux, or windows based on current OS', () => {
      const platform = detectPlatform();
      if (process.platform === 'darwin') {
        expect(platform).toBe('macos');
      } else if (process.platform === 'linux') {
        expect(platform).toBe('linux');
      } else if (process.platform === 'win32') {
        expect(platform).toBe('windows');
      } else {
        expect(platform).toBe('unsupported');
      }
    });
  });

  describe('getNodePath', () => {
    it('returns a path to node', () => {
      const nodePath = getNodePath();
      expect(nodePath).toMatch(/node/);
    });
  });

  describe('generateLaunchdPlist', () => {
    it('generates valid plist XML', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).toContain('<?xml version="1.0"');
      expect(plist).toContain('<string>com.copilot-bridge</string>');
      expect(plist).toContain('/Users/test/copilot-bridge');
      expect(plist).toContain('/Users/test</string>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain('tsx');
      expect(plist).toContain('dist/index.js');
    });

    it('uses ~/.copilot-bridge/copilot-bridge.log for log path', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).toContain('/Users/test/.copilot-bridge/copilot-bridge.log');
      expect(plist).not.toContain('/tmp/copilot-bridge.log');
    });

    it('includes Umask key', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).toContain('<key>Umask</key>');
      expect(plist).toContain('<integer>63</integer>');
    });
  });

  describe('generateSystemdUnit', () => {
    it('generates valid systemd unit', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      expect(unit).toContain('Copilot Bridge');
      expect(unit).toContain('/home/test/copilot-bridge');
      expect(unit).toContain('tsx');
      expect(unit).toContain('dist/index.js');
      expect(unit).toContain('Restart=always');
      expect(unit).toContain('WantedBy=multi-user.target');
    });

    it('includes UMask directive', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toContain('UMask=0077');
    });

    it('quotes paths in ExecStart for spaces', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/my project/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toMatch(/ExecStart="[^"]*" "[^"]*" "[^"]*"/);
    });
  });

  describe('getLogPath', () => {
    it('returns path under .copilot-bridge', () => {
      expect(getLogPath('/Users/test')).toBe('/Users/test/.copilot-bridge/copilot-bridge.log');
      expect(getLogPath('/home/test')).toBe('/home/test/.copilot-bridge/copilot-bridge.log');
    });
  });

  describe('generateNewsyslogConfig', () => {
    it('generates config with correct log path and user', () => {
      const config = generateNewsyslogConfig('/Users/test/.copilot-bridge/copilot-bridge.log', 'test');
      expect(config).toContain('/Users/test/.copilot-bridge/copilot-bridge.log');
      expect(config).toContain('test:');
      expect(config).toContain('600');
      expect(config).toContain('NCZ');
    });
  });

  describe('getNewsyslogInstallPath', () => {
    it('returns /etc/newsyslog.d/copilot-bridge.conf', () => {
      expect(getNewsyslogInstallPath()).toBe('/etc/newsyslog.d/copilot-bridge.conf');
    });
  });

  describe('install paths', () => {
    it('launchd path is under LaunchAgents', () => {
      const p = getLaunchdInstallPath();
      expect(p).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.copilot-bridge.plist'));
    });

    it('systemd path is /etc/systemd/system/', () => {
      const p = getSystemdInstallPath();
      expect(p).toBe('/etc/systemd/system/copilot-bridge.service');
    });
  });

  describe('getWindowsLogPath', () => {
    it('returns path under .copilot-bridge', () => {
      expect(getWindowsLogPath('C:\\Users\\test')).toBe(
        path.join('C:\\Users\\test', '.copilot-bridge', 'copilot-bridge.log'),
      );
      expect(getWindowsLogPath('/home/test')).toBe('/home/test/.copilot-bridge/copilot-bridge.log');
    });
  });

  describe('isNssmAvailable', () => {
    it('returns a boolean', () => {
      // On non-Windows CI the result is always false; we just verify the type.
      const result = isNssmAvailable();
      expect(typeof result).toBe('boolean');
      if (process.platform !== 'win32') {
        expect(result).toBe(false);
      }
    });
  });
});
