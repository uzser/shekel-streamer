import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Settings from an optional JSON file (CONFIG_FILE). Keys are case-insensitive and use the
 * same names as the environment variables. The file is the safe way to pass secrets: unlike
 * environment variables, its content does not show in `docker inspect` or `/proc/<pid>/environ`,
 * and child processes (Chromium) do not inherit it.
 * Example (Home Assistant add-on options): /data/options.json
 */
function loadConfigFile(path) {
  if (!path) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    config[key.toUpperCase()] = typeof value === 'object' ? value : String(value);
  }
  return config;
}

const fileConfig = loadConfigFile(process.env.CONFIG_FILE);

// CONFIG_FILE_DELETE=true: remove the file after reading, so that no later process (for example,
// a compromised browser renderer under the same user) can read the secrets from disk.
if (process.env.CONFIG_FILE && process.env.CONFIG_FILE_DELETE === 'true') {
  fs.unlinkSync(process.env.CONFIG_FILE);
}

/**
 * Returns a setting: the config file wins over the environment.
 * @param {string} name Setting name, e.g. TELEGRAM_BOT_TOKEN
 * @param {any} defaultValue
 */
export function cfg(name, defaultValue = undefined) {
  const value = fileConfig[name] ?? process.env[name];
  return value === undefined || value === '' ? defaultValue : value;
}

/**
 * All settings as one flat object (environment + config file).
 */
export function allSettings() {
  return { ...process.env, ...fileConfig };
}
