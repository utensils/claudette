import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://utensils.github.io',
  base: '/claudette',
  integrations: [
    starlight({
      title: 'Claudette',
      description:
        'A beautiful desktop orchestrator for parallel Claude Code agents.',
      logo: {
        src: './src/assets/hero-mascot.png',
        replacesTitle: false,
      },
      favicon: '/favicon.png',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/utensils/Claudette',
        },
        {
          icon: 'discord',
          label: 'Discord',
          href: 'https://discord.gg/aumGBKccmD',
        },
      ],
      customCss: [
        '@fontsource/inter/400.css',
        '@fontsource/inter/500.css',
        '@fontsource/inter/600.css',
        './src/styles/custom.css',
        './src/styles/homepage.css',
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/first-workspace' },
            { slug: 'getting-started/workflow' },
          ],
        },
        {
          label: 'Core Features',
          items: [
            { slug: 'features/parallel-agents' },
            { slug: 'features/git-worktrees' },
            { slug: 'features/scm-providers' },
            { slug: 'features/diff-viewer' },
            { slug: 'features/integrated-terminal' },
            { slug: 'features/remote-workspaces' },
            { slug: 'features/agent-configuration' },
            { slug: 'features/theming' },
            { slug: 'features/keyboard-shortcuts' },
            { slug: 'features/per-repo-settings' },
            { slug: 'features/settings' },
          ],
        },
        {
          label: 'Quickstart',
          autogenerate: { directory: 'quickstart' },
        },
        { slug: 'built-with' },
        { slug: 'privacy' },
      ],
      lastUpdated: true,
    }),
  ],
});
