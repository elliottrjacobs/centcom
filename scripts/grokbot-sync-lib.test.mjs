import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildProfile, dedupeSkills, grokbotId, matchSkills, parseSkillFile, sameProfile, splitDescription } from './grokbot-sync-lib.mjs';

describe('grokbotId', () => {
  it('kebab-cases the bot name behind a grokbot- prefix, matching the ids already in CENTCOM', () => {
    assert.equal(grokbotId('Stan'), 'grokbot-stan');
    assert.equal(grokbotId('Security Watch'), 'grokbot-security-watch');
    assert.equal(grokbotId('Chief of Staff - BiteMark'), 'grokbot-chief-of-staff-bitemark');
    assert.equal(grokbotId('dr eggbot'), 'grokbot-dr-eggbot');
    assert.equal(grokbotId('  X Post Optimizer!! '), 'grokbot-x-post-optimizer');
    assert.equal(grokbotId('last30days'), 'grokbot-last30days');
  });
});

describe('splitDescription', () => {
  it('a short single paragraph is the description, with no instructions', () => {
    assert.deepEqual(splitDescription("The owner's general-purpose assistant. Sets things up.", ''), { description: "The owner's general-purpose assistant. Sets things up.", instructions: '' });
  });

  it('an empty description falls back to the title, else stays empty', () => {
    assert.deepEqual(splitDescription('', 'last30days Bot'), { description: 'last30days Bot', instructions: '' });
    assert.deepEqual(splitDescription('   ', ''), { description: '', instructions: '' });
  });

  it('long instructions: the description is the opening sentences (cut at a sentence end), the instructions are the full text', () => {
    const first = 'You are Pocock Coder, a coding bot. Your one job: do coding tasks in his repos, e.g. fixes and features. ';
    const text = `${first}${'More detail about the job that goes on. '.repeat(8)}\n\nHow you work:\n- Grill first.\n\nVoice: short.`;
    const { description, instructions } = splitDescription(text, '');
    assert.equal(description, 'You are Pocock Coder, a coding bot. Your one job: do coding tasks in his repos, e.g. fixes and features. More detail about the job that goes on. More detail about the job that goes on. More detail about the job that goes on. More detail about the job that goes on.');
    assert.ok(description.length <= 300);
    assert.equal(instructions, text);
  });

  it('a single paragraph longer than 400 characters is split too', () => {
    const text = `Head of marketing for BiteMark. ${'Owns positioning and launches. '.repeat(15)}`.trim();
    const { description, instructions } = splitDescription(text, '');
    assert.ok(description.startsWith('Head of marketing for BiteMark. Owns positioning and launches.'));
    assert.ok(description.endsWith('.'));
    assert.equal(instructions, text);
  });

  it('an opening sentence longer than the cap is cut at a word boundary', () => {
    const text = `${'word '.repeat(100)}end.\n\nSecond paragraph.`;
    const { description } = splitDescription(text, '');
    assert.ok(description.length <= 300);
    assert.ok(description.endsWith(' word…'), 'whole words only');
  });
});

describe('parseSkillFile', () => {
  it('reads name and description in plain, quoted and folded styles', () => {
    assert.deepEqual(parseSkillFile('---\nname: pocock-tdd\ndescription: Test-driven development. Use it.\n---\n# body'), { name: 'pocock-tdd', description: 'Test-driven development. Use it.' });
    assert.deepEqual(parseSkillFile('---\nname: wtf\ndescription: "Explain the \\"why\\": fast"\nargument-hint: x\n---\n'), { name: 'wtf', description: 'Explain the "why": fast' });
    assert.deepEqual(parseSkillFile("---\nname: 'File CENTCOM work'\ndescription: >-\n  Files work in CENTCOM\n  before starting.\n\n  Second line.\nother: 1\n---\n"), { name: 'File CENTCOM work', description: 'Files work in CENTCOM before starting.\nSecond line.' });
    assert.equal(parseSkillFile('# no frontmatter'), null);
  });
});

describe('matchSkills', () => {
  const library = [
    { folder: 'grill-me', name: 'grill-me', description: 'A relentless interview.' },
    { folder: 'implement', name: 'implement', description: 'Implement a plan.' },
    { folder: 'implement-spec', name: 'implement-spec', description: 'Implement a spec.' },
    { folder: 'lfg', name: 'lfg', description: 'Hands-off.' },
    { folder: 'wtf', name: 'wtf', description: 'Explain.' },
    { folder: 'pr', name: 'pr', description: 'Pull requests.' },
    { folder: 'file-centcom-work', name: 'File CENTCOM work', description: `${'Long description. '.repeat(20)}`.trim() },
  ];

  it('includes skills named in the text, by folder or frontmatter name, sorted by name', () => {
    const skills = matchSkills('Use grill-me first, then implement-spec. Always File CENTCOM work before a PR.', library);
    assert.deepEqual(skills.map((s) => s.name), ['file-centcom-work', 'grill-me', 'implement-spec']);
  });

  it('ignores mentions in a sentence that forbids them, and names shorter than 3 characters', () => {
    const text = 'Run lfg when asked.\nAnti-jobs: never use Compound Engineering skills (lfg, wtf). Open a pr.\nDo not run grill-me. Avoid implement.';
    assert.deepEqual(matchSkills(text, library).map((s) => s.name), ['lfg']);
  });

  it('a skill counts when any one mention is allowed', () => {
    assert.deepEqual(matchSkills("Don't grill-me at night.\nUse grill-me by day.", library).map((s) => s.name), ['grill-me']);
    assert.deepEqual(matchSkills('Never use wtf. Don’t use lfg either.', library), []);
  });

  it('matches skill names case-sensitively: a capitalised word in prose is not the lowercase skill', () => {
    const lib = [{ folder: 'research', name: 'research', description: 'Research a topic.' }];
    assert.deepEqual(matchSkills('Research what people say about the launch.', lib), []);
    assert.deepEqual(matchSkills('RESEARCH everything.', lib), []);
    assert.deepEqual(matchSkills('Start with some research on competitors.', lib).map((s) => s.name), ['research']);
  });

  it('truncates the skill description to about 200 characters', () => {
    const [skill] = matchSkills('File CENTCOM work.', library);
    assert.ok(skill.description.length <= 200);
    assert.ok(skill.description.endsWith('…'));
  });
});

describe('dedupeSkills', () => {
  it('lists folders sharing a frontmatter name once, under the folder without a numeric suffix', () => {
    const library = [
      { folder: 'centcom-tracker-2', name: 'CENTCOM tracker', description: 'Copy.' },
      { folder: 'centcom-tracker', name: 'CENTCOM tracker', description: 'Original.' },
      { folder: 'grill-me', name: 'grill-me', description: 'Interview.' },
    ];
    assert.deepEqual(dedupeSkills(library), [
      { folder: 'centcom-tracker', name: 'CENTCOM tracker', description: 'Original.' },
      { folder: 'grill-me', name: 'grill-me', description: 'Interview.' },
    ]);
  });

  it('drops `<folder>-<digit>` when `<folder>` exists, even under another name, and keeps it when it does not', () => {
    const library = [
      { folder: 'pr', name: 'pr', description: 'Pull requests.' },
      { folder: 'pr-3', name: 'pull-request', description: 'Old copy.' },
      { folder: 'web-3', name: 'web-3', description: 'Web3 things.' },
    ];
    assert.deepEqual(dedupeSkills(library).map((s) => s.folder), ['pr', 'web-3']);
  });

  it('a bot mentioning a duplicated skill gets it once, named by the unsuffixed folder', () => {
    const library = dedupeSkills([
      { folder: 'file-centcom-work-2', name: 'File CENTCOM work', description: 'Files work.' },
      { folder: 'file-centcom-work', name: 'File CENTCOM work', description: 'Files work.' },
    ]);
    assert.deepEqual(matchSkills('Always File CENTCOM work first, see file-centcom-work.', library).map((s) => s.name), ['file-centcom-work']);
  });
});

describe('buildProfile + sameProfile', () => {
  it('builds what gets PUT, and recognises an unchanged profile on the server', () => {
    const wanted = buildProfile({ name: 'Stan', description: 'General assistant. Uses grill-me.', title: '' }, [{ folder: 'grill-me', name: 'grill-me', description: 'Interview.' }]);
    assert.deepEqual(wanted, { id: 'grokbot-stan', name: 'Stan', description: 'General assistant. Uses grill-me.', instructions: '', skills: [{ name: 'grill-me', description: 'Interview.' }], source: 'grokbot-sync' });
    const remote = { ...wanted, deliverables: [{ id: 'x' }], updated: 1, updatedBy: 'grokbot-stan', path: 'Agents/grokbot-stan.md' };
    assert.equal(sameProfile(remote, wanted), true);
    assert.equal(sameProfile({ ...remote, description: 'Changed.' }, wanted), false);
    assert.equal(sameProfile({ ...remote, source: 'self-reported' }, wanted), false);
    assert.equal(sameProfile(null, wanted), false);
  });
});
