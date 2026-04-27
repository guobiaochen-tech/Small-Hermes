import fs from 'fs';
import path from 'path';

const SKILLS_DIR = path.resolve(process.cwd(), 'skills');
if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

export interface SkillMeta {
  name: string;
  description: string;
  category: string;
  trigger?: string;
  created: string;
  modified: string;
}

export interface Skill extends SkillMeta {
  content: string; // full markdown content
}

function parseSkill(name: string, fullContent: string): Skill | null {
  const metaMatch = fullContent.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!metaMatch) return null;

  const metaLines = metaMatch[1].split('\n');
  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const body = fullContent.slice(metaMatch[0].length);
  return {
    name: name.replace(/\.md$/, ''),
    description: meta.description || '',
    category: meta.category || '',
    trigger: meta.trigger || '',
    created: meta.created || '',
    modified: meta.modified || '',
    content: fullContent,
  };
}

/** 列出所有技能（仅元数据） */
export function listSkills(): SkillMeta[] {
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const fullPath = path.join(SKILLS_DIR, f);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const parsed = parseSkill(f, content);
    if (parsed) {
      const { content: _c, ...meta } = parsed;
      return meta;
    }
    return {
      name: f.replace(/\.md$/, ''),
      description: '',
      category: '',
      trigger: '',
      created: '',
      modified: '',
    };
  });
}

/** 获取单个技能完整内容 */
export function getSkill(name: string): Skill | null {
  const safeName = name.replace(/[/\\?%*:|"<>.]/g, '').trim();
  const filePath = path.join(SKILLS_DIR, `${safeName}.md`);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSkill(name, content);
}

/** 创建技能 */
export function createSkill(name: string, description: string, category: string, body: string): Skill {
  const safeName = name.replace(/[/\\?%*:|"<>.]/g, '').trim();
  const now = new Date().toISOString();
  const fullContent = `---
name: ${safeName}
description: ${description}
category: ${category}
created: ${now}
modified: ${now}
---

${body}
`;
  fs.writeFileSync(path.join(SKILLS_DIR, `${safeName}.md`), fullContent, 'utf-8');
  return parseSkill(safeName, fullContent)!;
}

/** 更新技能 */
export function updateSkill(name: string, updates: { description?: string; category?: string; body?: string }): Skill | null {
  const existing = getSkill(name);
  if (!existing) return null;

  const now = new Date().toISOString();
  const description = updates.description ?? existing.description;
  const category = updates.category ?? existing.category;
  const body = updates.body ?? existing.content.replace(/^---[\s\S]*?---\n?/, '');

  const fullContent = `---
name: ${name}
description: ${description}
category: ${category}
created: ${existing.created}
modified: ${now}
---

${body}
`;
  fs.writeFileSync(path.join(SKILLS_DIR, `${name}.md`), fullContent, 'utf-8');
  return parseSkill(name, fullContent);
}

/** 删除技能 */
export function deleteSkill(name: string): boolean {
  const safeName = name.replace(/[/\\?%*:|"<>.]/g, '').trim();
  const filePath = path.join(SKILLS_DIR, `${safeName}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}
