// GET /api/records                      all skill records (sheet rows A-T)
// GET /api/records?email=…              one student's records
// GET /api/records?studentId=BTU-T-0001
// GET /api/records?status=NOT%20SYNCED  by sync status (SYNCED, NOT SYNCED, FAILED)
// GET /api/records?skillId=SKL-001
const { data, send, query, only } = require("./_data");

module.exports = (req, res) => {
  if (!only(req, res)) return;
  const q = query(req);
  let rows = data.rows;
  if (q.email) rows = rows.filter((r) => r.email.toLowerCase() === q.email.trim().toLowerCase());
  if (q.studentId) rows = rows.filter((r) => r.studentId === q.studentId);
  if (q.status) rows = rows.filter((r) => r.syncStatus === q.status.toUpperCase());
  if (q.skillId) rows = rows.filter((r) => r.skillId === q.skillId);
  send(res, 200, { sheet: data.sheet, count: rows.length, rows });
};
