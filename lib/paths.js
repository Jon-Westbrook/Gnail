import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultDataDirectory({ platform = process.platform, home = homedir(), env = process.env, exists = existsSync } = {}) {
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    const legacy = join(support, 'G-NAIL');
    return exists(legacy) ? legacy : join(support, 'GNAIL');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'gnail');
}
