/**
 * Builds the public website into dist-site/ (`pnpm build:site`): the home page from site/home.html,
 * and /privacy/ and /support/ from docs/PRIVACY.md and docs/SUPPORT.md, so the pages the App Store
 * links to always say what the repository says. Static HTML and CSS only, no client JavaScript.
 * Colors, spacing and fonts come from the app's own src/styles/tokens.css.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import siteConfig from '../site/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Markdown documents published as pages. Links between them stay on the site. */
export const docPages = [
  {
    source: 'docs/PRIVACY.md',
    url: '/privacy/',
    description: 'What CENTCOM collects (nothing) and where your data lives.',
  },
  {
    source: 'docs/SUPPORT.md',
    url: '/support/',
    description: 'Help with CENTCOM: getting started, the iPhone app, bug reports and contact.',
  },
];

const home = {
  title: 'CENTCOM: a project tracker for you and your AI agents',
  description:
    'CENTCOM is an open-source, self-hosted project and task tracker shared by people and their AI agents, with a Mac app, an iPhone app, a CLI and MCP, all over plain Markdown files.',
};

/** Files copied as they are: [source relative to the repo, destination relative to the site]. */
const staticFiles = [
  ['src/styles/tokens.css', 'tokens.css'],
  ['site/site.css', 'site.css'],
  ['public/favicon-32.png', 'favicon-32.png'],
  ['public/favicon-192.png', 'favicon-192.png'],
  ['public/apple-touch-icon.png', 'apple-touch-icon.png'],
];

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Replaces every `{{name}}`; an unknown name is a mistake in a template, so it throws. */
export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`No value for {{${key}}}`);
    return values[key];
  });
}

/**
 * Where a link in a published document points on the website. Absolute URLs and anchors are kept;
 * a link to another published document stays on the site; anything else in the repository opens on
 * GitHub, where the repository's relative links work.
 */
export function resolveDocLink(href, fromFile, repo = siteConfig.repo) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return href;
  const [file = '', hash] = href.split('#');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), file));
  const suffix = hash ? `#${hash}` : '';
  const page = docPages.find((p) => p.source === target);
  if (page) return page.url + suffix;
  if (target === 'README.md') return `${repo}${suffix || '#readme'}`;
  return `${repo}/blob/main/${target}${suffix}`;
}

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Renders a repository Markdown file as page HTML, with its first heading as the title. */
export function renderDoc(markdown, fromFile, repo = siteConfig.repo) {
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link') token.href = resolveDocLink(token.href, fromFile, repo);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (!title) throw new Error(`${fromFile} has no top-level heading to use as its title`);
  return { title, html: marked.parse(markdown) };
}

function nav(current, config) {
  const links = [
    ['/#get', 'Download'],
    ['/support/', 'Support'],
    [config.repo, 'GitHub'],
  ];
  return links
    .map(([href, label]) => `<a href="${escapeHtml(href)}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('\n      ');
}

const comingSoon = (text) => `<p class="soon">${escapeHtml(text)}</p>`;

/** The Mac card's actions: a download button and the Homebrew command once each exists. */
export function macActions(config) {
  const parts = [];
  if (config.macDownload) parts.push(`<a class="button button-primary" href="${escapeHtml(config.macDownload)}">Download for Mac</a>`);
  if (config.homebrew) parts.push(`<pre class="code-inline"><code>${escapeHtml(config.homebrew)}</code></pre>`);
  if (!config.macDownload && !config.homebrew) return comingSoon('Coming soon');
  if (!config.macDownload) parts.unshift(comingSoon('Download coming soon'));
  if (!config.homebrew) parts.push(comingSoon('Homebrew cask coming soon'));
  return parts.join('\n        ');
}

/** The iPhone card's action: Apple's official badge once the app is released. */
export function iosActions(config, siteDir) {
  if (!config.appStore) return comingSoon('Coming soon to the App Store');
  const badge = 'assets/app-store-badge.svg';
  if (!existsSync(path.join(siteDir, badge))) {
    throw new Error(`appStore is set, so site/${badge} must hold Apple's official "Download on the App Store" badge (Apple Marketing Tools)`);
  }
  return `<a class="app-store" href="${escapeHtml(config.appStore)}"><img src="/${badge}" width="120" height="40" alt="Download on the App Store"></a>`;
}

/** Builds the site into `outDir`, replacing what is there. Returns the files written, relative to it. */
export async function buildSite({ outDir = path.join(root, 'dist-site'), config = siteConfig, repoRoot = root } = {}) {
  const siteDir = path.join(repoRoot, 'site');
  const layout = await fs.readFile(path.join(siteDir, 'layout.html'), 'utf8');
  const written = [];
  const write = async (rel, body) => {
    const file = path.join(outDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    written.push(rel);
  };
  const page = (rel, { title, description, url, bodyClass, content }) =>
    write(
      rel,
      fill(layout, {
        title: escapeHtml(title),
        description: escapeHtml(description),
        canonical: escapeHtml(config.origin + url),
        origin: escapeHtml(config.origin),
        bodyClass,
        nav: nav(url, config),
        content,
        repo: escapeHtml(config.repo),
        contact: escapeHtml(config.contact),
        publisher: escapeHtml(config.publisher),
      }),
    );

  await fs.rm(outDir, { recursive: true, force: true });

  const homeBody = await fs.readFile(path.join(siteDir, 'home.html'), 'utf8');
  await page('index.html', {
    ...home,
    url: '/',
    bodyClass: 'home',
    content: fill(homeBody, { repo: escapeHtml(config.repo), macActions: macActions(config), iosActions: iosActions(config, siteDir) }),
  });

  for (const doc of docPages) {
    const { title, html } = renderDoc(await fs.readFile(path.join(repoRoot, doc.source), 'utf8'), doc.source, config.repo);
    await page(`${doc.url.slice(1)}index.html`, {
      title: `${title} · CENTCOM`,
      description: doc.description,
      url: doc.url,
      bodyClass: 'doc',
      content: `<div class="wrap wrap-prose">\n<article class="prose">\n${html}</article>\n</div>`,
    });
  }

  await page('404.html', {
    title: 'Page not found · CENTCOM',
    description: home.description,
    url: '/404.html',
    bodyClass: 'doc',
    content: `<div class="wrap wrap-prose not-found">\n<h1>Page not found</h1>\n<p>That page does not exist. <a href="/">Go to the home page</a>.</p>\n</div>`,
  });

  for (const [from, to] of staticFiles) {
    await write(to, await fs.readFile(path.join(repoRoot, from)));
  }
  for (const name of await fs.readdir(path.join(siteDir, 'assets'))) {
    if (!name.startsWith('.')) await write(`assets/${name}`, await fs.readFile(path.join(siteDir, 'assets', name)));
  }

  const urls = ['/', ...docPages.map((d) => d.url)];
  await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escapeHtml(config.origin + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`);
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = path.join(root, 'dist-site');
  const files = await buildSite({ outDir });
  console.log(`dist-site: ${files.length} files`);
}
