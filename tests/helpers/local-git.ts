import {
  prepareGitWorkspace,
  previewRunGit,
  joinCrateWorktrees,
} from '../../src/server/git-workspaces.js';

/** Explicit opt-in for integration tests whose repositories live under mkdtemp. */
export const localGitEffects = {
  prepareGit: prepareGitWorkspace,
  previewGit: previewRunGit,
  joinGit: joinCrateWorktrees,
};
