import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillsShStore, markInstalledStoreSkills, SkillStoreError } from '../src/capabilities/skills/skills-sh';
import { SkillParser } from '../src/capabilities/skills/skill-parser';

const source = 'vercel-labs/agent-skills';
const skillId = 'test-skill';
const document = '---\nname: test-skill\ndescription: Test skill\n---\nRead references/details.md.\n';
const entry = { source, skillId, name: skillId, installs: 123 };
function snapshot(files = [{ path: 'SKILL.md', contents: document }, { path: 'references/details.md', contents: 'Useful details.' }]) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path).update(file.contents);
  return { files, hash: hash.digest('hex') };
}

test('skills.sh lists real identities, caches pages independently, refreshes, and encodes search', async () => {
  const urls: string[] = [];
  const store = new SkillsShStore(async url => {
    urls.push(url);
    return { skills: [entry, entry], total: 401, hasMore: true };
  });
  const page = await store.list();
  assert.equal(page.skills.length, 1);
  assert.equal(page.skills[0].url, `https://skills.sh/${source}/${skillId}`);
  assert.equal(page.hasMore, true);
  await store.list();
  assert.equal(urls.length, 1);
  await store.list('', 1);
  await store.list('', 0, true);
  const search = await store.list('react & native');
  assert.equal(search.hasMore, false);
  assert.equal(new URL(urls[3]).searchParams.get('q'), 'react & native');
  assert.equal(urls[1], 'https://skills.sh/api/skills/all-time/1');
});

test('bad upstream responses fail visibly and do not poison the cache', async () => {
  let count = 0;
  const store = new SkillsShStore(async () => ++count === 1 ? {} : { skills: [] });
  await assert.rejects(store.list(), SkillStoreError);
  assert.deepEqual((await store.list()).skills, []);
});

test('installs one snapshot with references, local digest and upstream provenance, without replacing existing content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skills-sh-'));
  const skills = path.join(root, 'skills');
  try {
    const urls: string[] = [];
    const store = new SkillsShStore(async url => { urls.push(url); return { ...snapshot(), hash: 'a'.repeat(64) }; });
    const result = await store.install(source, skillId, skills);
    assert.equal(result.name, skillId);
    assert.equal(result.hash, snapshot().hash);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.path, '.skills-sh.json'), 'utf8')).upstreamHash, 'a'.repeat(64));
    assert.equal(SkillParser.parse(path.join(result.path, 'SKILL.md')).metadata.name, skillId);
    assert.equal(fs.readFileSync(path.join(result.path, 'references/details.md'), 'utf8'), 'Useful details.');
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.path, '.skills-sh.json'), 'utf8')).source, source);
    assert.deepEqual(fs.readdirSync(root), ['skills']);
    assert.deepEqual(fs.readdirSync(skills), [skillId]);
    assert.equal(urls[0], `https://skills.sh/api/download/${source}/${skillId}`);
    await assert.rejects(store.install(source, skillId, skills), (error: any) => error.status === 409);
    assert.equal(urls.length, 1);
    const catalog = (await new SkillsShStore(async () => ({ skills: [entry, { ...entry, source: 'another/publisher' }] })).list()).skills;
    assert.deepEqual(markInstalledStoreSkills(catalog, skills).map(s => s.installed), [true, false]);
    assert.equal(fs.readFileSync(path.join(result.path, 'SKILL.md'), 'utf8'), document);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy nested packages remain recognizable without contacting the old registry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-legacy-skills-'));
  try {
    fs.mkdirSync(path.join(root, 'old-repo/skills/test-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'old-repo/skills/test-skill/SKILL.md'), document);
    const catalog = (await new SkillsShStore(async () => ({ skills: [entry] })).list()).skills;
    assert.equal(markInstalledStoreSkills(catalog, root)[0].installed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects malformed snapshots, name mismatches, unsafe paths and partial packages without leaving an installation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-snapshot-validation-'));
  const skills = path.join(root, 'skills');
  try {
    const invalid = [
      { ...snapshot(), hash: 'not-a-version-hash' },
      snapshot([{ path: 'SKILL.md', contents: document.replace('name: test-skill', 'name: wrong-skill') }]),
      snapshot([{ path: 'SKILL.md', contents: 'Not a valid skill' }]),
      snapshot([{ path: 'references/details.md', contents: 'No entry point' }]),
      snapshot([{ path: 'SKILL.md', contents: document }, { path: 'skill.md', contents: document }]),
      ...['../outside', '/outside', 'C:/outside', 'scripts/../../outside', 'scripts\\outside', '.GIT/config', '.skills-sh.json'].map(p =>
        snapshot([{ path: 'SKILL.md', contents: document }, { path: p, contents: 'bad' }])),
    ];
    for (const data of invalid) {
      await assert.rejects(new SkillsShStore(async () => data).install(source, skillId, skills));
      assert.equal(fs.existsSync(path.join(skills, skillId)), false);
      assert.ok(fs.readdirSync(root).every(name => !name.startsWith('.xiaoba-skill-install-')));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
