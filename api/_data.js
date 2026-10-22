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

// Endpoints that return personal data (names, e-mails) need the API key when the
// API_KEY environment variable is set (Vercel → Settings → Environment Variables).
// Send it as "Authorization: Bearer <key>" or "x-api-key: <key>". Never commit the key.
function authorized(req, res) {
  const key = process.env.API_KEY;
  if (!key) return true;
  const h = req.headers || {};
  const given = h["x-api-key"] || String(h.authorization || "").replace(/^Bearer\s+/i, "");
  if (given === key) return true;
  send(res, 401, { error: "API key required" });
  return false;
}

module.exports = { data, send, query, only, authorized };
