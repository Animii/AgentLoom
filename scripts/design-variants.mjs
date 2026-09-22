import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const variants = [
  [
    'studio',
    'StudioShell',
    'Creative studio: warm ivory, burnt orange, large confident typography, horizontal navigation, spacious composition. Make it feel like a beautifully crafted creative tool.',
  ],
  [
    'mission',
    'MissionShell',
    'Operations console: deep navy/charcoal with electric cyan, compact left rail, precise typography, dense split-pane workflow oversight. Professional, restrained, high contrast.',
  ],
  [
    'garden',
    'GardenShell',
    'Calm review workspace: pale sage, forest green, editorial serif headings, generous whitespace, prominent actionable approval queue, human-centered clarity. Left navigation and a distinct summary composition.',
  ],
];
await mkdir('artifacts', { recursive: true });
const contract = `import type { ReactNode } from 'react';
export interface DesignShellProps {
 navigation: ReactNode;
 children: ReactNode;
 summary: { total: number; approval: number; running: number; finished: number };
 onNewRun: () => void;
 onShowApprovals: () => void;
}
`;
await mkdir('src/client/variants', { recursive: true });
await writeFile('src/client/variants/types.ts', contract);
await Promise.all(
  variants.map(async ([id, name, direction]) => {
    const dir = path.join(root, 'workspaces', 'ui-design', id);
    await mkdir(dir, { recursive: true });
    for (const file of [
      'App.tsx',
      'styles.css',
      'RunDetail.tsx',
      'WorkflowEditor.tsx',
      'ProvidersView.tsx',
      'JevPanel.tsx',
      'NewRunDialog.tsx',
    ])
      await writeFile(
        path.join(dir, file),
        await readFile(path.join(root, 'src/client', file)),
      );
    await writeFile(path.join(dir, 'types.ts'), contract);
    const prompt = `You are independent UI/UX designer ${id}, using Claude Fable 5.1. Product owner authorizes you to design and implement ONE distinct working UI variant of AgentLoom, local workflow platform. Direction: ${direction}
Read provided App.tsx and styles.css and component files for actual DOM/classes. Output ONLY ${name}.tsx, ${id}.css and DESIGN.md in current directory. Do not edit other files. No shell, no network, no credentials. You are authorized to implement your visual design in these files.
Contract: default export function ${name}(props:DesignShellProps) from './types'. Import './${id}.css'. props.navigation contains existing nav buttons Runs/Workflows/Agents; render it inside a nav aria-label Primary. props.children contains existing <main className="main"> with all operational UI and NewRunDialog; render children exactly once, always mounted, without hiding existing features. Root must have className="design-${id} app-shell". You may add decorative brand, truthful summary values, a custom sidebar/topbar, contextual summary, functional buttons invoking onNewRun and onShowApprovals. Navigation and button behavior supplied by parent. No new dependencies; lucide-react icons or inline SVG allowed. No fake projects, names, metrics, connection statuses, charts. All summary values are real. Avoid duplicate New run accessible names; shell CTA can be 'Start a workflow'.
CSS MUST scope EVERY selector under .design-${id} (including overrides to .main, .page-head, .board, .stats, .run-card, .detail-column, .panel, dialogs etc). Use existing CSS variables overriding on root; do not set :root/body globally. Do thorough styling of existing children, not just shell. Make materially different layout, spacing, hierarchy, navigation, surfaces, typography. Do not hide existing operational controls. Read existing CSS carefully for fixed heights and media queries; override properly. Shell lives BELOW a 76px design comparison switcher owned by parent. Use min-height:calc(100dvh - 76px) instead of 100vh, natural page scrolling preferred; prevent overflow at 390px and 1440px. Root CSS variables inherited by dialog. Accessible contrast, keyboard focus and reduced motion. Mobile <760px adapt navigation and board stacked. Aim polished production UI. Avoid large empty hero that pushes actual tasks away. No design switcher inside your shell (parent provides it). No implementation notes visible to user. Functional real data only.
Use Read/Write/Edit tools to create all three output files now. Finish with concise design rationale.`;
    await writeFile(path.join(dir, 'brief.txt'), prompt);
    await new Promise((resolve, reject) => {
      const proc = spawn(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          '-w',
          `/workspaces/ui-design/${id}`,
          'platform',
          'claude',
          '-p',
          '--safe-mode',
          '--name',
          `AgentLoom-design-${id}`,
          '--model',
          'claude-fable-5-1',
          '--effort',
          'high',
          '--output-format',
          'stream-json',
          '--verbose',
          '--tools',
          'Read,Write,Edit,Glob,Grep',
          '--allowedTools',
          'Read,Write,Edit,Glob,Grep',
        ],
        { cwd: root, shell: false, windowsHide: true },
      );
      let output = '',
        error = '';
      proc.stdout.on('data', (d) => (output += d));
      proc.stderr.on('data', (d) => (error += d));
      proc.on('error', reject);
      proc.on('close', async (code) => {
        await writeFile(`artifacts/design-${id}.jsonl`, output);
        await writeFile(`artifacts/design-${id}.stderr.txt`, error);
        console.log(`${id}: exit ${code}`);
        code === 0 ? resolve() : reject(new Error(`${id} failed ${code}`));
      });
      proc.stdin.end(prompt);
    });
    for (const file of [`${name}.tsx`, `${id}.css`])
      await writeFile(
        path.join(root, 'src/client/variants', file),
        await readFile(path.join(dir, file)),
      );
    console.log(`${id}: files copied`);
  }),
);
