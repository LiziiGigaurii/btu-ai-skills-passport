// GET /api/skills                  the AI skill catalog (ID, name, category, stamp code, description)
// GET /api/skills?category=AI%20Skill
const { data, send, query, only } = require("./_data");
const BADGE = { "AI Skill": "BDG-AI-001", "AI Applied Skill": "BDG-AI-002", "AI Advanced Skill": "BDG-AI-003" };

module.exports = (req, res) => {
  if (!only(req, res)) return;
  const q = query(req);
  const map = new Map();
  for (const r of data.rows) if (r.skillId && !map.has(r.skillId)) map.set(r.skillId, { skillId: r.skillId, name: r.skillName, category: r.category, badgeCode: BADGE[r.category] || "", description: r.description });
  let list = [...map.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
  if (q.category) list = list.filter((s) => s.category === q.category);
  send(res, 200, { count: list.length, skills: list });
};
