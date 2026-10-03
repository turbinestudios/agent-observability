import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateSaltHex } from '@agent-observability/core/src/secrets/pseudonymize';
import { computeDeveloperId, getIdentityInput } from '@agent-observability/core/src/aggregate/pseudonymizer';

/**
 * The per-install salt behind this member's anonymous id, in its OWN file.
 *
 * Not in `config.json`, deliberately: that file is user-readable and
 * user-edited, Settings offers to open its folder, people paste it into bug
 * reports, and the datahost copies it whole into the background worker's
 * `workerData`. The salt is the one secret that turns an anonymous id back
 * into a person (given the team's emails), so it lives where nothing else
 * reads, with owner-only permissions where the OS honours them, and it never
 * enters a shard or the shared folder.
 *
 * The extension keeps its salt in VS Code SecretStorage; the two salts are
 * unrelated, so the same person appears under different ids in the cloud
 * dashboard and in a team folder. That is documented, not a bug.
 */
export function resolveTeamSaltPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'team-salt');
}

export function getOrCreateTeamSalt(file: string = resolveTeamSaltPath()): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      return existing;
    }
  } catch {
    // Absent or unreadable: mint a new one below.
  }
  const salt = generateSaltHex();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, salt, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the home directory is already user-scoped.
  }
  return salt;
}

/**
 * This install's anonymous id. Identity input falls back from git email to
 * the OS username; the desktop has no VS Code machineId, which is fine
 * because the per-install salt already makes the id unique per install.
 */
export function getTeamDeveloperId(salt: string): string {
  return computeDeveloperId(salt, getIdentityInput().input);
}
