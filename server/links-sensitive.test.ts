/**
 * What may be linked. A linked folder is readable through the API, by every agent over MCP,
 * and by remote token-holders, so this is the guard between "show me my skills" and
 * "serve my private keys". Pure function, fake home: no filesystem involved.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sensitiveTargetReason } from './links.ts';

const HOME = '/Users/someone';
const at = (rel: string) => path.join(HOME, rel);
const refused = (target: string) => assert.notEqual(sensitiveTargetReason(target, HOME), null, `should refuse ${target}`);
const allowed = (target: string) => assert.equal(sensitiveTargetReason(target, HOME), null, `should allow ${target}`);

describe('link targets: secrets are never linkable', () => {
  it('refuses credential stores, and anything inside or containing them', () => {
    for (const rel of ['.ssh', '.ssh/keys', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config/gcloud', '.config/gh', 'Library/Keychains']) {
      refused(at(rel));
    }
    refused(at('.config')); // contains .config/gcloud and .config/gh
  });

  it('refuses hidden folders by default, not just the ones on a list', () => {
    for (const rel of ['.npmrc.d', '.terraform.d', '.m2', '.vault', '.some-tool-nobody-listed', 'Projects/app/.env.d', 'Projects/app/.git']) {
      refused(at(rel));
    }
  });

  it('refuses an agent tool folder itself, because its top level holds credentials (auth.json)', () => {
    for (const rel of ['.codex', '.claude', '.cursor', '.agents']) refused(at(rel));
  });

  it('refuses a hidden folder nested below an agent tool folder', () => {
    refused(at('.claude/skills/.secrets'));
  });

  it('refuses ~/Library except the iCloud documents area', () => {
    refused(at('Library'));
    refused(at('Library/Application Support/1Password'));
    refused(at('Library/Mobile Documents')); // the container itself, too broad
  });
});

describe('link targets: the real use cases still work', () => {
  it('allows a skills repo and ordinary folders', () => {
    allowed(at('Projects/exocortex/skills'));
    allowed(at('Documents/Notes'));
    allowed('/Volumes/Work/skills');
  });

  it('allows subfolders of agent tool folders, global and per-project', () => {
    allowed(at('.claude/skills'));
    allowed(at('.codex/skills'));
    allowed(at('.agents/skills'));
    allowed(at('Projects/BiteMark/bitemark-mobile/.claude/skills'));
    allowed(at('Projects/family-office/.agents/skills'));
  });

  it('allows an Obsidian vault in iCloud, so session logs can be linked rather than copied', () => {
    allowed(at('Library/Mobile Documents/iCloud~md~obsidian/Documents/CENTCOM/Sessions'));
  });
});
