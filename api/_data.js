// Shared by every /api endpoint: the hackathon test data (data/test-data.json).
// In production this module would query the university database instead.
const data = require("../data/test-data.json");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}

// Accepts Vercel's request object or a plain Node one.
function query(req) {
  return Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
}

function only(req, res) {
  if (req.method === "OPTIONS") { send(res, 204, {}); return false; }
  if (req.method !== "GET") { send(res, 405, { error: "Only GET is supported" }); return false; }
  return true;
}

module.exports = { data, send, query, only };
