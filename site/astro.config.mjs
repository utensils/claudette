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
          icon: 'discord',
          label: 'Discord',
          href: 'https://discord.gg/aumGBKccmD',
        },
        {
          icon: 'reddit',
          label: 'r/ClaudetteApp',
          href: 'https://www.reddit.com/r/ClaudetteApp/',
        },
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/utensils/Claudette',
        },
      ],
      customCss: [
        '@fontsource/inter/400.css',
        '@fontsource/inter/500.css',
        '@fontsource/inter/600.css',
        './src/styles/custom.css',
        './src/styles/homepage.css',
      ],
      components: {
        // Renders the default site title plus our primary nav (Features /
        // Docs / Releases) next to the logo. See `src/components/SiteTitle.astro`.
        SiteTitle: './src/components/SiteTitle.astro',
      },
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
        { slug: 'contributing-translations' },
        { slug: 'privacy' },
      ],
      lastUpdated: true,
    }),
  ],
});
