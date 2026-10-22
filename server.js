// Local development server: serves the website and the /api endpoints.
//   node server.js        → http://localhost:3000
// On Vercel the files in api/ become the same endpoints automatically.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const API = { records: require("./api/records"), students: require("./api/students"), skills: require("./api/skills") };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".pdf": "application/pdf", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const api = /^\/api\/([a-z]+)\/?$/.exec(url.pathname);
  if (api) {
    if (API[api[1]]) return API[api[1]](req, res);
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unknown endpoint", endpoints: Object.keys(API).map((k) => "/api/" + k) }));
  }
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!file.startsWith(ROOT) || /[\\/]\.|node_modules|server\.js$/.test(file.slice(ROOT.length))) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("BTU AI Skills Passport → http://localhost:" + PORT + "  (API: /api/records, /api/students, /api/skills)"));
