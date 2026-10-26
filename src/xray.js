import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import config from './config.js';

function xrayBinary() {
  return process.env.XRAY_BIN || config.checker.xrayBinary;
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function buildCheckConfig(outbound, localPort) {
  return {
    log: { loglevel: config.checker.xrayLogLevel },
    inbounds: [
      {
        tag: 'check',
        listen: '127.0.0.1',
        port: localPort,
        protocol: 'http',
        settings: { allowTransparent: false }
      }
    ],
    outbounds: [{ ...outbound, tag: 'vpn' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', inboundTag: ['check'], outboundTag: 'vpn' }]
    }
  };
}

export function writeTempConfig(configObject) {
  const file = path.join(os.tmpdir(), `xray-check-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(configObject));
  return file;
}

export function waitForPort(port, timeoutMs, isAlive = () => true) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      if (!isAlive()) {
        resolve(false);
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (ok) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 100);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(500, () => done(false));
    };
    attempt();
  });
}

function runCommand(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ ok: false, code: null, stdout, stderr: 'Command timeout' });
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout = (stdout + data.toString()).slice(-12000);
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-12000);
    });
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export async function testConfig(configPath, timeoutMs) {
  const result = await runCommand(xrayBinary(), ['run', '-test', '-config', configPath], timeoutMs);
  if (!result.ok) {
    return { ok: false, output: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}` };
  }
  return { ok: true, output: result.stdout.trim() };
}

export function startXray(configPath) {
  const proc = spawn(xrayBinary(), ['run', '-config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  proc.stdout.on('data', (data) => {
    stdoutBuffer = (stdoutBuffer + data.toString()).slice(-16000);
  });
  proc.stderr.on('data', (data) => {
    stderrBuffer = (stderrBuffer + data.toString()).slice(-16000);
  });
  proc.on('exit', () => {
    exited = true;
  });
  proc.on('error', (error) => {
    exited = true;
    stderrBuffer += `\n[spawn error] ${error.message}`;
  });

  return {
    proc,
    isAlive: () => !exited && proc.exitCode === null && !proc.killed,
    getOutput: () => ({ stdout: stdoutBuffer.trim(), stderr: stderrBuffer.trim() })
  };
}

export function stopXray(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function cleanupConfig(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}
