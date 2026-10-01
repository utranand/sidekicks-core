import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BSD_INFO_SIZE = 136;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= 2147483647;

// Darwin libproc.h proc_pidinfo; sys/proc_info.h PROC_PIDTBSDINFO / proc_bsdinfo.
// Both supported Darwin architectures use this 136-byte little-endian layout.
const DARWIN_START_SCRIPT = `
ObjC.import('Foundation');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
function run(args) {
  const b = $.NSMutableData.dataWithLength(136);
  const n = $.proc_pidinfo(Number(args[0]), 3, 0, b.mutableBytes, 136);
  return JSON.stringify({size: n, data: ObjC.unwrap(b.base64EncodedStringWithOptions(0))});
}`;

/** A malformed or unavailable native observation never grants PID identity. */
export function parseDarwinProcessStart(raw, bootId, pid) {
  if (!validPid(pid) || typeof raw !== 'string' || raw.length > 4096
      || typeof bootId !== 'string' || !UUID.test(bootId)) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.size !== BSD_INFO_SIZE || typeof value.data !== 'string') return null;
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== BSD_INFO_SIZE || bytes.toString('base64') !== value.data
        || bytes.readUInt32LE(12) !== pid) return null;
    const seconds = bytes.readBigUInt64LE(120);
    const micros = bytes.readBigUInt64LE(128);
    if (seconds < 1n || seconds > BigInt(Number.MAX_SAFE_INTEGER) || micros > 999999n) return null;
    const digest = createHash('sha256')
      .update(`darwin:${bootId.toLowerCase()}:${seconds}:${micros}`, 'utf8')
      .digest('hex').slice(0, 40);
    return `start-${digest}`;
  } catch {
    return null;
  }
}

export function observeDarwinProcessStartToken(pid, run = spawnSync) {
  if (!validPid(pid)) return null;
  const options = { encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 8192 };
  const succeeded = (result) => result && result.status === 0 && !result.error && !result.signal;
  try {
    const boot = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options);
    if (!succeeded(boot) || typeof boot.stdout !== 'string' || !UUID.test(boot.stdout.trim())) return null;
    const observed = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_START_SCRIPT, String(pid)], options);
    if (!succeeded(observed)) return null;
    return parseDarwinProcessStart(observed.stdout, boot.stdout.trim(), pid);
  } catch {
    return null;
  }
}
