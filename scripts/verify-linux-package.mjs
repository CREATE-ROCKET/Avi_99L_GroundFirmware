#!/usr/bin/env node

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPackage = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
const appImage = path.join(
  repository,
  'release',
  `CREATE-99L-Ground-Station-${appPackage.version}-Linux-x64.AppImage`,
);
const probe = [
  "const path = require('node:path')",
  "const { SerialPort } = require(path.join(process.resourcesPath, 'app.asar', 'node_modules', 'serialport'))",
  "SerialPort.list().then((ports) => console.log(JSON.stringify({ ok: true, portCount: ports.length, paths: ports.map((port) => port.path) })), (error) => { console.error(error); process.exitCode = 1 })",
].join(';');

if (!fs.existsSync(appImage)) throw new Error(`AppImage not found: ${appImage}`);
fs.chmodSync(appImage, 0o755);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-99l-appimage-verify-'));
try {
  const extract = spawnSync(appImage, ['--appimage-extract'], {
    cwd: temp,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) {
    if (extract.stderr) process.stderr.write(extract.stderr);
    throw new Error(`AppImage extraction exited with status ${extract.status}`);
  }

  const appDir = path.join(temp, 'squashfs-root');
  const executable = path.join(appDir, 'create-99l-ground-station');
  if (!fs.existsSync(executable)) throw new Error(`packaged Electron binary not found: ${executable}`);
  fs.chmodSync(executable, 0o755);

  const result = spawnSync(executable, ['-e', probe], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APPDIR: appDir,
      LD_LIBRARY_PATH: [path.join(appDir, 'usr', 'lib'), process.env.LD_LIBRARY_PATH]
        .filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`packaged serialport probe exited with status ${result.status}`);

  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!output) throw new Error('packaged serialport probe returned no output');
  const parsed = JSON.parse(output);
  if (parsed.ok !== true || !Number.isSafeInteger(parsed.portCount) || parsed.portCount < 0
      || !Array.isArray(parsed.paths) || parsed.paths.length !== parsed.portCount
      || parsed.paths.some((portPath) => typeof portPath !== 'string' || portPath.length === 0)) {
    throw new Error('packaged serialport probe returned an invalid result');
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
