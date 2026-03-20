#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const commands = {
  start: join(root, 'dist', 'index.js'),
  init: join(root, 'scripts', 'init.ts'),
  check: join(root, 'scripts', 'check.ts'),
  'install-service': join(root, 'scripts', 'install-service.ts'),
  'uninstall-service': join(root, 'scripts', 'uninstall-service.ts'),
  'service-start': join(root, 'scripts', 'start-service.ts'),
  'service-stop': join(root, 'scripts', 'stop-service.ts'),
  'service-status': join(root, 'scripts', 'service-status.ts'),
};

const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log(`bridge — Mattermost ↔ GitHub Copilot bridge

Usage: bridge <command>

Commands:
  init               Interactive setup wizard
  check              Validate configuration
  start              Start the bridge

Service management:
  install-service    Install as system service (macOS/Linux/Windows)
  uninstall-service  Remove system service
  service-start      Start the installed service
  service-stop       Stop the running service
  service-status     Show service status

Options:
  --help, -h         Show this help
  --version, -v      Show version`);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const script = commands[command];
if (!script) {
  console.error(`Unknown command: ${command}\nRun 'bridge --help' for usage.`);
  process.exit(1);
}

// Use --import tsx/esm for TypeScript and ESM compatibility
const child = spawn(process.execPath, ['--import', 'tsx/esm', script, ...process.argv.slice(3)], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, BRIDGE_CLI: '1' },
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error(`Failed to run command: ${err.message}`);
  process.exit(1);
});
