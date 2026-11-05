import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import siteConfig from '../site/config.mjs';
import { buildSite, docPages, fill, iosActions, macActions, renderDoc, resolveDocLink } from './build-site.mjs';

const repo = 'https://github.com/example/centcom';

describe('resolveDocLink', () => {
  it('keeps links between published documents on the site', () => {
    assert.equal(resolveDocLink('SUPPORT.md', 'docs/PRIVACY.md', repo), '/support/');
    assert.equal(resolveDocLink('PRIVACY.md#contact', 'docs/SUPPORT.md', repo), '/privacy/#contact');
  });

  it('sends other repository files to GitHub, resolved from the document', () => {
    assert.equal(resolveDocLink('../SECURITY.md', 'docs/PRIVACY.md', repo), `${repo}/blob/main/SECURITY.md`);
    assert.equal(resolveDocLink('REMOTE-ACCESS.md', 'docs/SUPPORT.md', repo), `${repo}/blob/main/docs/REMOTE-ACCESS.md`);
    assert.equal(resolveDocLink('../README.md', 'docs/SUPPORT.md', repo), `${repo}#readme`);
    assert.equal(resolveDocLink('../README.md#remote-access', 'docs/SUPPORT.md', repo), `${repo}#remote-access`);
  });

  it('leaves absolute URLs, mail links and anchors alone', () => {
    for (const href of ['https://example.com/x', 'mailto:info@extendedmind.studio', '#contact']) {
      assert.equal(resolveDocLink(href, 'docs/PRIVACY.md', repo), href);
    }
  });
});

describe('renderDoc', () => {
  it('takes the title from the first heading, gives headings ids and rewrites links', () => {
    const { title, html } = renderDoc('# Privacy policy\n\n## Where your data goes\n\nSee [security](../SECURITY.md).\n', 'docs/PRIVACY.md', repo);
    assert.equal(title, 'Privacy policy');
    assert.match(html, /<h2 id="where-your-data-goes">Where your data goes<\/h2>/);
    assert.match(html, new RegExp(`href="${repo}/blob/main/SECURITY.md"`));
  });

  it('refuses a document without a title', () => {
    assert.throws(() => renderDoc('No heading here.', 'docs/X.md', repo), /no top-level heading/);
  });
});

describe('fill', () => {
  it('throws on a placeholder with no value, so a template typo never ships', () => {
    assert.equal(fill('a {{b}} c', { b: 'x' }), 'a x c');
    assert.throws(() => fill('{{missing}}', {}), /No value for \{\{missing\}\}/);
  });
});

describe('download links', () => {
  it('shows "coming soon" instead of a dead button until a link exists', () => {
    assert.doesNotMatch(macActions({}), /<a /);
    assert.match(macActions({}), /Coming soon/);
    assert.match(iosActions({}, 'unused'), /Coming soon to the App Store/);
  });

  it('shows each Mac option once it is set', () => {
    const both = macActions({ macDownload: 'https://example.com/dl', homebrew: 'brew install --cask centcom' });
    assert.match(both, /href="https:\/\/example.com\/dl"/);
    assert.match(both, /brew install --cask centcom/);
    assert.doesNotMatch(both, /Coming soon/);
    assert.match(macActions({ macDownload: 'https://example.com/dl' }), /Homebrew cask coming soon/);
  });

  it('requires the official App Store badge before linking the App Store', () => {
    const empty = os.tmpdir();
    assert.throws(() => iosActions({ appStore: 'https://apps.apple.com/app/id1' }, empty), /official/);
  });
});

describe('buildSite', () => {
  let out;
  before(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), 'centcom-site-'));
    await buildSite({ outDir: out });
  });
  after(() => fs.rm(out, { recursive: true, force: true }));

  const read = (rel) => fs.readFile(path.join(out, rel), 'utf8');
  const htmlPages = ['index.html', '404.html', ...docPages.map((d) => `${d.url.slice(1)}index.html`)];

  it('writes the home page and one page per published document', async () => {
    for (const page of htmlPages) assert.ok(existsSync(path.join(out, page)), page);
    assert.match(await read('privacy/index.html'), /<title>Privacy policy · CENTCOM<\/title>/);
    assert.match(await read('support/index.html'), /<title>Support · CENTCOM<\/title>/);
  });

  it('leaves no unfilled placeholders or repository-relative Markdown links', async () => {
    for (const page of htmlPages) {
      const html = await read(page);
      assert.doesNotMatch(html, /\{\{\w+\}\}/, page);
      assert.doesNotMatch(html, /href="(?!https?:)[^"]*\.md[#"]/, page);
    }
  });

  it('only links to files that exist on the site', async () => {
    for (const page of htmlPages) {
      const html = await read(page);
      for (const [, ref] of html.matchAll(/(?:href|src|srcset)="(\/[^"#]*)/g)) {
        const file = ref.endsWith('/') ? `${ref}index.html` : ref;
        assert.ok(existsSync(path.join(out, file)), `${page} links to missing ${ref}`);
      }
    }
  });

  it('uses only the public contact address', async () => {
    for (const page of htmlPages) {
      const emails = new Set((await read(page)).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []);
      for (const email of emails) assert.equal(email, siteConfig.contact, `${page} shows ${email}`);
    }
    assert.match(await read('privacy/index.html'), /mailto:info@extendedmind\.studio/);
  });

  it('links to the repository and the privacy and support pages from every page', async () => {
    for (const page of htmlPages) {
      const html = await read(page);
      for (const href of [siteConfig.repo, '/privacy/', '/support/']) assert.ok(html.includes(`href="${href}"`), `${page} lacks ${href}`);
    }
  });
});
