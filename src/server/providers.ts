import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, ProviderId, ProviderInfo } from '../shared/types.js';

export { parseAgentLine } from './provider-stream.js';
export { createExecutor } from './provider-process.js';

interface ProviderSpec {
  name: string;
  suggestedModel: string;
  efforts: string[];
  loginCommand: string;
}

const SPECS: Record<ProviderId, ProviderSpec> = {
  claude: {
    name: 'Claude Code',
    suggestedModel: 'claude-fable-5-1',
    efforts: ['low', 'medium', 'high', 'max'],
    loginCommand: 'docker compose exec platform claude auth login',
  },
  codex: {
    name: 'Codex',
    suggestedModel: '',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    loginCommand: 'docker compose exec platform codex login --device-auth',
  },
  opencode: {
    name: 'OpenCode',
    suggestedModel: 'deepseek/deepseek-flash',
    efforts: ['low', 'high', 'max'],
    loginCommand: 'docker compose exec platform opencode auth login',
  },
};

const DEFAULT_BINARIES: Record<ProviderId, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

export function resolveBinary(config: AppConfig, id: ProviderId): string {
  const override = config.binaries?.[id];
  if (override) return override;
  if (
    id === 'opencode' &&
    process.platform === 'win32' &&
    process.env.APPDATA
  ) {
    const exe = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe',
    );
    if (existsSync(exe)) return exe;
  }
  return DEFAULT_BINARIES[id];
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping ANSI colour codes requires the ESC control character
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

type ProbeResult = Pick<ProviderInfo, 'installed' | 'version' | 'error'>;

function probe(binary: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--version'],
      { timeout: 5000, windowsHide: true, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) {
          const message = error.message.replace(/\s+/g, ' ').trim();
          resolve({
            installed: false,
            version: null,
            error: message.slice(0, 200),
          });
          return;
        }
        const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
        resolve({
          installed: true,
          version: stripAnsi(firstLine).trim().slice(0, 200),
          error: null,
        });
      },
    );
  });
}

export async function getProviders(config: AppConfig): Promise<ProviderInfo[]> {
  const ids: ProviderId[] = ['claude', 'codex', 'opencode'];
  return Promise.all(
    ids.map((id): Promise<ProviderInfo> => {
      const spec = SPECS[id];
      return probe(resolveBinary(config, id)).then((result) => ({
        id,
        name: spec.name,
        installed: result.installed,
        version: result.version,
        authentication: 'not_checked',
        error: result.error,
        suggestedModel: spec.suggestedModel,
        efforts: spec.efforts,
        loginCommand: spec.loginCommand,
      }));
    }),
  );
}
