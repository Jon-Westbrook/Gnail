import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultDataDirectory({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'GNAIL');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'gnail');
}
