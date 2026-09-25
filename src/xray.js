import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * Build a minimal Xray config for checking a single outbound through a local SOCKS inbound.
 * "direct" is present as a second outbound (Xray wants at least a sane default outbound to
 * exist) but is never reachable: the single routing rule sends everything from the "check"
 * inbound straight to "vpn" — there is no path through which a check can silently succeed
 * over "direct" instead of the actual proxy.
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
        settings: { auth: 'noauth', udp: false }
      }
    ],
    outbounds: [
      { ...outbound, tag: 'vpn' },
      { tag: 'direct', protocol: 'freedom' }
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', inboundTag: ['check'], outboundTag: 'vpn' }]
    }
  };
}

export function writeTempConfig(config) {
  const file = path.join(os.tmpdir(), `xray-check-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

/**
 * Poll a local port until it accepts a connection or the timeout elapses. Each individual
 * connection attempt gets its own short timeout so one hung attempt can't eat the whole budget.
 */
export function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
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

/**
 * Run a short-lived command, capturing BOTH stdout and stderr (Xray doesn't consistently put
 * everything on stderr), with a hard timeout that SIGKILLs on expiry instead of trusting the
 * child to exit on its own.
 */
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
      } catch {
        // already gone
      }
      resolve({ ok: false, code: null, stdout, stderr: 'Command timeout' });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 12000) stdout = stdout.slice(-12000);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.once('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });

    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * Validate a config with Xray's own "-test" flag BEFORE spawning a long-running process.
 * This is what actually tells apart "our JSON is malformed for this outbound" from "the
 * process just didn't bind the port in time" — two very different problems that used to
 * look identical (both just showed up as a silent FAIL).
 */
export async function testConfig(configPath, timeoutMs = 10000) {
  const bin = process.env.XRAY_BIN || 'xray';
  const result = await runCommand(bin, ['run', '-test', '-config', configPath], timeoutMs);
  if (!result.ok) {
    const message = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return { ok: false, output: message };
  }
  return { ok: true, output: result.stdout.trim() };
}

export function startXray(configPath) {
  const bin = process.env.XRAY_BIN || 'xray';
  const proc = spawn(bin, ['run', '-config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let stdoutBuf = '';
  let stderrBuf = '';

  // Both streams are drained (not just piped-and-ignored): if nobody reads them and Xray
  // writes enough output, the OS pipe buffer fills up and Xray blocks on write() — which can
  // make an otherwise-working server look like it "hung". Draining also means we can show the
  // real reason on any failure instead of a bare "FAIL".
  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    if (stdoutBuf.length > 16000) stdoutBuf = stdoutBuf.slice(-16000);
  });
  proc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
  });

  proc.on('exit', () => {
    exited = true;
  });
  proc.on('error', (err) => {
    exited = true;
    stderrBuf += `\n[spawn error] ${err.message}`;
  });

  return {
    proc,
    isAlive: () => !exited && proc.exitCode === null && !proc.killed,
    getOutput: () => ({ stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() })
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
