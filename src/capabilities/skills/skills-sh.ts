import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SkillParser } from './skill-parser';

const ORIGIN = 'https://skills.sh';
const RECEIPT = '.skills-sh.json';
const CACHE_TTL = 5 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillStoreError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export interface StoreSkill {
  id: string;
  name: string;
  source: string;
  skillId: string;
  installs: number;
  description: string;
  url: string;
}

export interface StorePage {
  skills: StoreSkill[];
  page: number;
  total: number;
  hasMore: boolean;
}

type RequestJson = (url: string) => Promise<unknown>;

async function requestJson(url: string): Promise<unknown> {
  try {
    // CONNECT preserves HTTPS across redirects, including in managed cloud proxies.
    const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    const host = new URL(url).hostname;
    const bypass = (process.env.no_proxy || process.env.NO_PROXY || '').split(/[\s,]+/).some(entry => {
      const value = entry.toLowerCase().replace(/:443$/, '');
      return value === '*' || value === host || (value.startsWith('.') && host.endsWith(value));
    });
    return (await axios.get(url, {
      timeout: 15000, maxContentLength: MAX_BYTES,
      ...(proxy && !bypass ? { proxy: false as const, httpsAgent: new HttpsProxyAgent(proxy) } : {}),
    })).data;
  } catch {
    throw new SkillStoreError('skills.sh 暂时不可用，请稍后重试。');
  }
}

function validateIdentity(source: unknown, skillId: unknown): asserts source is string {
  if (typeof source !== 'string' || !SOURCE.test(source)
    || typeof skillId !== 'string' || !SLUG.test(skillId) || skillId.length > 100) {
    throw new SkillStoreError('请选择有效的 skills.sh Skill（source 和 skillId）。', 400);
  }
}

/** Thin adapter for the directory and snapshot APIs used by the skills.sh ecosystem. */
export class SkillsShStore {
  private cache = new Map<string, { time: number; value: StorePage }>();

  constructor(private readonly request: RequestJson = requestJson) {}

  async list(query = '', page = 0, refresh = false): Promise<StorePage> {
    query = query.trim();
    if ((query && query.length < 2) || query.length > 100 || !Number.isSafeInteger(page) || page < 0 || page > 1000) {
      throw new SkillStoreError('搜索词需为 2–100 个字符，页码需为非负整数。', 400);
    }
    const url = query
      ? `${ORIGIN}/api/search?${new URLSearchParams({ q: query, limit: '100' })}`
      : `${ORIGIN}/api/skills/all-time/${page}`;
    const cached = this.cache.get(url);
    if (!refresh && cached && Date.now() - cached.time < CACHE_TTL) return cached.value;
    const data = await this.request(url) as any;
    if (!data || !Array.isArray(data.skills)) throw new SkillStoreError('skills.sh 返回了无法识别的技能列表。');
    const skills = new Map<string, StoreSkill>();
    for (const item of data.skills) {
      if (!item || typeof item.source !== 'string' || !SOURCE.test(item.source)
        || typeof item.skillId !== 'string' || !SLUG.test(item.skillId) || item.skillId.length > 100) continue;
      const id = `${item.source}/${item.skillId}`;
      skills.set(id, {
        id, source: item.source, skillId: item.skillId,
        name: typeof item.name === 'string' ? item.name : item.skillId,
        description: typeof item.description === 'string' ? item.description : '',
        installs: Number.isFinite(item.installs) && item.installs >= 0 ? Math.floor(item.installs) : 0,
        url: `${ORIGIN}/${id}`,
      });
    }
    if (data.skills.length && !skills.size) throw new SkillStoreError('skills.sh 技能列表缺少有效来源。');
    const value = {
      skills: [...skills.values()], page: query ? 0 : page,
      total: Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : skills.size,
      hasMore: !query && data.hasMore === true && skills.size > 0,
    };
    if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { time: Date.now(), value });
    return value;
  }

  async install(source: unknown, skillId: unknown, skillsRoot: string): Promise<{ name: string; path: string; hash: string }> {
    validateIdentity(source, skillId);
    const slug = skillId as string;
    const target = path.resolve(skillsRoot, slug);
    if (fs.existsSync(target)) throw new SkillStoreError(`Skill 目录 “${slug}” 已存在，请先在已安装列表中检查。`, 409);
    const data = await this.request(`${ORIGIN}/api/download/${source}/${slug}`) as any;
    if (!data || !Array.isArray(data.files) || !data.files.length || data.files.length > 2000
      || typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(data.hash)) {
      throw new SkillStoreError('skills.sh 下载包缺少文件或内容校验值。');
    }
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of data.files) {
      if (!file || typeof file.path !== 'string' || !file.path || typeof file.contents !== 'string'
        || file.path.includes('\\') || file.path.includes('\0') || path.posix.isAbsolute(file.path)
        || /^[a-z]:/i.test(file.path)
        || file.path.split('/').some((part: string) => !part || ['.', '..', '.git', RECEIPT].includes(part.toLowerCase()))) {
        throw new SkillStoreError('skills.sh 下载包包含非法文件路径。');
      }
      const portablePath = file.path.toLowerCase();
      if (paths.has(portablePath)) throw new SkillStoreError('skills.sh 下载包包含重复文件路径。');
      paths.add(portablePath);
      bytes += Buffer.byteLength(file.contents, 'utf8');
      if (bytes > MAX_BYTES) throw new SkillStoreError('skills.sh 下载包超出大小限制。');
    }
    // Matches vercel-labs/skills computeSnapshotHash: sorted path + text, SHA-256.
    const hash = createHash('sha256');
    for (const file of [...data.files].sort((a: any, b: any) => a.path.localeCompare(b.path))) {
      hash.update(file.path); hash.update(file.contents);
    }
    // Upstream hash is an opaque version fingerprint (not this payload's checksum).
    const contentHash = hash.digest('hex');
    const main = data.files.find((file: any) => file.path.toLowerCase() === 'skill.md');
    if (!main) throw new SkillStoreError('skills.sh 下载包根目录缺少 SKILL.md。');
    fs.mkdirSync(skillsRoot, { recursive: true });
    // Stay outside the watched Skills tree until the complete package is ready.
    const staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(skillsRoot)), '.xiaoba-skill-install-'));
    try {
      for (const file of data.files) {
        const dest = path.join(staging, file.path === main.path ? 'SKILL.md' : file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.contents, { flag: 'wx' });
      }
      let skill: ReturnType<typeof SkillParser.parse>;
      try { skill = SkillParser.parse(path.join(staging, 'SKILL.md')); }
      catch { throw new SkillStoreError('下载包包含无法解析的 SKILL.md。'); }
      if (typeof skill.metadata.name !== 'string' || typeof skill.metadata.description !== 'string') {
        throw new SkillStoreError('下载包包含无效的 Skill 元数据。');
      }
      const actualSlug = skill.metadata.name.toLowerCase().replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (actualSlug !== slug) throw new SkillStoreError('下载包的 Skill 名称与所选技能不一致。');
      fs.writeFileSync(path.join(staging, RECEIPT), JSON.stringify({
        source, skillId: slug, name: skill.metadata.name, hash: contentHash, upstreamHash: data.hash,
        installedAt: new Date().toISOString(),
      }, null, 2));
      if (fs.existsSync(target)) throw new SkillStoreError(`Skill 目录 “${slug}” 已存在。`, 409);
      fs.renameSync(staging, target);
      return { name: skill.metadata.name, path: target, hash: contentHash };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

/** Keep legacy packages visible; distinguish same-name skills from different publishers. */
export function markInstalledStoreSkills(entries: StoreSkill[], skillsRoot: string): Array<StoreSkill & { installed: boolean }> {
  const identities = new Set<string>();
  const legacyNames = new Set<string>();
  for (const folder of fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot, { withFileTypes: true }) : []) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    const root = path.join(skillsRoot, folder.name);
    const receipt = path.join(root, RECEIPT);
    if (fs.existsSync(receipt)) {
      try {
        const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (typeof data.source === 'string' && typeof data.skillId === 'string'
          && fs.existsSync(path.join(root, 'SKILL.md'))) identities.add(`${data.source}/${data.skillId}`);
      } catch { /* A broken receipt is not proof of an installed package. */ }
      continue;
    }
    // Existing repository installations can contain more than one nested Skill.
    for (const file of findLegacySkills(root)) {
      try { legacyNames.add(SkillParser.parse(file).metadata.name); } catch { /* Not a Skill. */ }
    }
  }
  return entries.map(entry => ({ ...entry, installed: identities.has(entry.id) || legacyNames.has(entry.name) }));
}

function findLegacySkills(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findLegacySkills(file));
    else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') files.push(file);
  }
  return files;
}
