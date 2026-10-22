// GET /api/students            every student with their passport ID and number of records
// GET /api/students?email=…    one student
const { data, send, query, only } = require("./_data");

module.exports = (req, res) => {
  if (!only(req, res)) return;
  const q = query(req);
  const map = new Map();
  for (const r of data.rows) {
    const s = map.get(r.studentId) || { studentId: r.studentId, firstName: r.firstName, lastName: r.lastName, email: r.email, program: r.program, educationLevel: r.educationLevel, studentStatus: r.studentStatus, passportId: "", records: 0 };
    if (r.passportId) s.passportId = r.passportId;
    s.records++;
    map.set(r.studentId, s);
  }
  let list = [...map.values()];
  if (q.email) list = list.filter((s) => s.email.toLowerCase() === q.email.trim().toLowerCase());
  send(res, 200, { count: list.length, students: list });
};
