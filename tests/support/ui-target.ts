import { readFileSync } from 'node:fs';
import path from 'node:path';

/** A generated marker prevents accidentally directing browser mutations at a live app. */
export function uiTarget(environment: NodeJS.ProcessEnv): string {
  const {
    AGENTLOOM_TEST_ROOT: root,
    E2E_BASE_URL: address,
    E2E_WORKSPACE_ROOT: workspace,
  } = environment;
  if (!root || !address || !workspace)
    throw new Error(
      'Run browser tests with npm run test:ui. The isolated test harness owns the server and workspace.',
    );
  const url = new URL(address);
  if (
    url.hostname !== '127.0.0.1' ||
    url.protocol !== 'http:' ||
    url.port === '4317' ||
    !url.port
  ) {
    throw new Error(
      'Browser tests require a disposable loopback server on a non-production port.',
    );
  }
  const marker: unknown = JSON.parse(
    readFileSync(path.join(root, 'ui-harness.json'), 'utf8'),
  );
  if (
    !marker ||
    typeof marker !== 'object' ||
    !('address' in marker) ||
    marker.address !== address ||
    !('workspace' in marker) ||
    marker.workspace !== workspace ||
    path.relative(root, workspace) !== 'workspaces'
  ) {
    throw new Error(
      'Browser test target does not match the test-owned workspace marker.',
    );
  }
  return address;
}
