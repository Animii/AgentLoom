import { runUiChild, withUiApp } from '../support/ui-harness.js';

process.exitCode = await withUiApp(
  {},
  ({ root }) => {
    // The nested child announces readiness only after runUiChild installs handlers.
    return runUiChild(
      [
        '-e',
        `console.log(${JSON.stringify(root)}); setInterval(() => {}, 1000);`,
      ],
      process.env,
    );
  },
  { built: false, temporaryParent: process.env.SIGNAL_TEST_PARENT },
);
