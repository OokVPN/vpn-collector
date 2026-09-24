import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * Build a minimal Xray config for checking a single outbound through a local SOCKS inbound.
 * No "direct" fallback is present — traffic on the "check" inbound is routed only to "vpn".
 */
export function buildCheckConfig(outbound, localPort) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'check',
        listen: '127.0.0.1',
        port: localPort,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true }
      }
    ],
    outbounds: [{ ...outbound, tag: 'vpn' }],
    routing: {
      rules: [{ type: 'field', inboundTag: ['check'], outboundTag: 'vpn' }]
    }
  };
}

export function writeTempConfig(config) {
  const file = path.join(os.tmpdir(), `xray-check-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

export function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    })();
  });
}

export function startXray(configPath) {
  const bin = process.env.XRAY_BIN || 'xray';
  const proc = spawn(bin, ['run', '-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });
  proc.on('error', () => {
    exited = true;
  });
  return {
    proc,
    isAlive: () => !exited && proc.exitCode === null && !proc.killed
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
      } catch {
        // already gone
      }
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
  } catch {
    // already removed
  }
}
