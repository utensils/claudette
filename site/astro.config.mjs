import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://utensils.github.io',
  base: '/claudette',
  // Redirects from old slugs that have been published. Keep these even after
  // the slug is renamed so external links / bookmarks don't 404.
  // Note: Astro applies the `base` prefix to source paths but not to
  // destination paths, so the destination must include `/claudette` itself.
  redirects: {
    '/features/alternative-backends': '/claudette/features/providers',
  },
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
          href: 'https://discord.gg/JQdfT3Z67F',
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
        // Inter is the body font on every route — keep global.
        '@fontsource/inter/400.css',
        '@fontsource/inter/500.css',
        '@fontsource/inter/600.css',
        // Silkscreen 400 is the display font for the header brand title —
        // must be global since the header appears on every page.
        // Weight 700 stays in `src/content/docs/index.mdx` (homepage-only).
        '@fontsource/silkscreen/400.css',
        // Header chrome (nav links, social icons, search-centering grid)
        // applies site-wide — also global.
        './src/styles/custom.css',
        // Note: `homepage.css` and `@fontsource/silkscreen/700.css`
        // are intentionally NOT here. They're imported in
        // `src/content/docs/index.mdx` so they only load on the splash
        // homepage, not on every docs page.
      ],
      components: {
        // Renders the default site title plus our primary nav (Features /
        // Docs / Releases) next to the logo. See `src/components/SiteTitle.astro`.
        SiteTitle: './src/components/SiteTitle.astro',
        // Injects Open Graph and Twitter Card meta tags for social link previews.
        Head: './src/components/Head.astro',
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
            { slug: 'features/checkpoints-and-forking' },
            { slug: 'features/diff-viewer' },
            { slug: 'features/file-editor' },
            { slug: 'features/integrated-terminal' },
            { slug: 'features/task-history' },
            { slug: 'features/notifications' },
            { slug: 'features/voice-input' },
            { slug: 'features/keyboard-shortcuts' },
            { slug: 'features/theming' },
            { slug: 'features/internationalization' },
          ],
        },
        {
          label: 'Agent Providers',
          items: [
            { slug: 'features/providers' },
            { slug: 'features/providers/ollama' },
            { slug: 'features/providers/lm-studio' },
            { slug: 'features/providers/openai-codex' },
          ],
        },
        {
          label: 'Agent Workflow',
          items: [
            { slug: 'features/agent-configuration' },
            { slug: 'features/plan-mode' },
            { slug: 'features/slash-commands' },
            { slug: 'features/pinned-prompts' },
            { slug: 'features/authentication' },
            { slug: 'features/usage-and-metrics' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { slug: 'features/scm-providers' },
            { slug: 'features/mcp-servers' },
            { slug: 'features/per-repo-settings' },
            { slug: 'features/required-inputs' },
            { slug: 'features/claude-remote-control' },
          ],
        },
        {
          label: 'Remote & CLI',
          items: [
            { slug: 'features/remote-workspaces' },
            { slug: 'features/cli-client' },
          ],
        },
        {
          label: 'Settings & Trust',
          items: [
            { slug: 'features/settings' },
            { slug: 'features/diagnostics' },
            { slug: 'features/experimental-features' },
            { slug: 'features/community-registry-trust' },
            { slug: 'privacy' },
          ],
        },
        {
          label: 'Quickstart',
          autogenerate: { directory: 'quickstart' },
        },
        {
          label: 'About',
          items: [
            { slug: 'built-with' },
            { slug: 'contributing-translations' },
          ],
        },
      ],
      lastUpdated: true,
    }),
  ],
});
