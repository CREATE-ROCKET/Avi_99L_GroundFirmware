#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'create-99l-ground-package-'));
const stagingOutput = path.join(staging, 'release');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...args], cwd);
    return;
  }
  if (process.platform === 'win32') {
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], cwd);
    return;
  }
  run('npm', args, cwd);
}

try {
  for (const relativePath of ['package.json', 'package-lock.json', 'dist', 'electron', 'shared']) {
    fs.cpSync(path.join(repository, relativePath), path.join(staging, relativePath), { recursive: true });
  }
  runNpm(['ci', '--omit=dev'], staging);
  const localBinding = path.join(
    staging,
    'node_modules',
    '@serialport',
    'bindings-cpp',
    'build',
    'Release',
    'bindings.node',
  );
  if (fs.existsSync(localBinding)) throw new Error('locally rebuilt serialport binding must not be packaged');
  const stagedPackagePath = path.join(staging, 'package.json');
  const stagedPackage = JSON.parse(fs.readFileSync(stagedPackagePath, 'utf8'));
  delete stagedPackage.build;
  fs.writeFileSync(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`, 'utf8');
  const builder = path.join(repository, 'node_modules', 'electron-builder', 'cli.js');
  run(process.execPath, [
    builder,
    ...process.argv.slice(2),
    `--config.directories.app=${staging}`,
    `--config.directories.output=${stagingOutput}`,
  ], repository);

  const output = path.join(repository, 'release');
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(stagingOutput, { withFileTypes: true })) {
    const source = path.join(stagingOutput, entry.name);
    const destination = path.join(output, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('-unpacked')) {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(source, destination, { recursive: true });
    } else if (entry.isFile()) fs.copyFileSync(source, destination);
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
