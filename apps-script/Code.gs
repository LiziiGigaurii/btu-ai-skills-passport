/**
 * BTU AI Skills Digital Passport: Google Sheet connector (Google Apps Script).
 *
 * Bind this script to the Google Sheet that holds the "Passport Skill Records" tab
 * (Extensions → Apps Script), then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Paste the /exec URL into the
 * website: Administration → Source settings.
 *
 * GET  ?action=read            → { rows: [ {studentId … syncError} ] }   (columns A–T)
 * POST {action:"append", rows:[{studentId … syncError}]}   adds rows from an uploaded results file
 *      (an enrollment row has Record ID "ENR-…" and empty skill columns: blank passport)
 * POST {action:"writeBack", updates:[{recordId, set:{…}}]}
 *      writes only system-managed fields: G (Passport ID), H (First Issued) on
 *      initial issuance, and Q–T (sync status, version, synced at, error).
 *
 * POST {action:"sendCode", email}            emails a one-time sign-in code (MailApp)
 * POST {action:"checkCode", email, code}      checks it → {ok:true, role:"student"|"admin"}
 * POST {action:"notify", items:[{email, name, passportId, version, code, verifyUrl, newSkills}]}
 *      e-mails each student that their passport has a new version (with a QR code to verify it)
 *      Codes are kept 10 minutes in CacheService; never returned to the browser.
 *
 * SECURITY: set Project Settings → Script Properties → API_TOKEN to a long random value and
 * enter the same value on the website (Administration → Source settings). Every data action
 * (read, writeBack, append, notify) then requires it, so the Web App URL alone does not
 * expose student data. The token is never stored in the code or the repository.
 * POST {action:"read", token}  same as GET ?action=read (GET is refused when API_TOKEN is set).
 *
 * Column N (Badge/Stamp Code) is a formula in the sheet and is never written.
 * Protect columns Q–T against human edits in the live sheet.
 */
const SHEET_NAME = "Passport Skill Records";
const ADMIN_EMAIL = "admin@btu.edu.ge"; // the one administrator account (same as on the website)
const FIELDS = ["studentId", "firstName", "lastName", "email", "program", "educationLevel", "passportId", "firstIssued",
  "studentStatus", "recordId", "skillId", "skillName", "category", "badgeCode", "description", "dateEarned",
  "syncStatus", "syncedVersion", "syncedAt", "syncError"]; // A–T
const WRITABLE = { passportId: 7, firstIssued: 8, syncStatus: 17, syncedVersion: 18, syncedAt: 19, syncError: 20 }; // 1-based columns

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error("Sheet not found: " + SHEET_NAME);
  return sh;
}

// The header row is the one whose column J says "Record ID" (row 4 in the BTU template).
function headerRow_(sh) {
  const top = sh.getRange(1, 1, Math.min(15, sh.getLastRow()), 20).getDisplayValues();
  for (let i = 0; i < top.length; i++) if (String(top[i][9]).trim() === "Record ID") return i + 1;
  throw new Error("Header row with 'Record ID' in column J not found");
}

// Date cells (Google Sheets turns typed or pasted 2026-10-21 into a date) are read in the
// spreadsheet's own time zone, otherwise midnight in Tbilisi would become the previous day in UTC.
function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  return v == null ? "" : String(v).trim();
}

function readRows_() {
  const sh = sheet_();
  const h = headerRow_(sh);
  const n = sh.getLastRow() - h;
  if (n <= 0) return [];
  const values = sh.getRange(h + 1, 1, n, 20).getValues();
  const rows = [];
  for (const r of values) {
    if (!/^BTU-/.test(cell_(r[0])) || !cell_(r[9])) continue; // skip blank lines and the technical notes block
    const o = {};
    FIELDS.forEach((f, i) => (o[f] = cell_(r[i])));
    o.syncedAt = r[18] instanceof Date ? Utilities.formatDate(r[18], "UTC", "yyyy-MM-dd HH:mm") + " UTC" : o.syncedAt;
    rows.push(o);
  }
  return rows;
}

function token_() {
  return PropertiesService.getScriptProperties().getProperty("API_TOKEN") || "";
}
function authorized_(given) {
  const t = token_();
  return !t || String(given || "") === t;
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "read";
  if (action !== "read") return json_({ error: "Unknown action" });
  if (token_()) return json_({ error: "unauthorized: use POST with the access token" });
  return json_({ rows: readRows_(), readAt: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.action === "sendCode") return json_(sendCode_(body.email));
    if (body.action === "checkCode") return json_(checkCode_(body.email, body.code));
    if (!authorized_(body.token)) return json_({ error: "unauthorized" });
    if (body.action === "read") return json_({ rows: readRows_(), readAt: new Date().toISOString() });
    if (body.action === "notify" && Array.isArray(body.items)) return json_(notify_(body.items));
    if (body.action === "append" && Array.isArray(body.rows)) return json_(appendRows_(body.rows));
    if (body.action !== "writeBack" || !Array.isArray(body.updates)) return json_({ error: "Bad request" });
    const sh = sheet_();
    const h = headerRow_(sh);
    const n = sh.getLastRow() - h;
    const ids = sh.getRange(h + 1, 10, n, 1).getDisplayValues().map((r) => r[0].trim());
    let written = 0;
    for (const u of body.updates) {
      const idx = ids.indexOf(String(u.recordId));
      if (idx < 0) continue;
      const row = h + 1 + idx;
      Object.keys(u.set || {}).forEach((k) => {
        if (WRITABLE[k]) sh.getRange(row, WRITABLE[k]).setValue(u.set[k]);
      });
      written++;
    }
    return json_({ ok: true, written });
  } finally {
    lock.releaseLock();
  }
}

// Adds new skill records (from an uploaded event results file) right after the last
// data row, above the technical notes block. Column N gets the badge-code formula.
function appendRows_(rows) {
  const sh = sheet_();
  const h = headerRow_(sh);
  const n = Math.max(0, sh.getLastRow() - h);
  const ids = n ? sh.getRange(h + 1, 1, n, 1).getDisplayValues().map((r) => r[0].trim()) : [];
  let last = h;
  ids.forEach((v, i) => { if (/^BTU-/.test(v)) last = h + 1 + i; });
  if (!rows.length) return { ok: true, appended: 0 };
  sh.insertRowsAfter(last, rows.length);
  const values = rows.map((o, i) => FIELDS.map((f, c) => {
    if (c === 13) return '=IF(M' + (last + 1 + i) + '="","",IF(M' + (last + 1 + i) + '="AI Skill","BDG-AI-001",IF(M' + (last + 1 + i) + '="AI Applied Skill","BDG-AI-002",IF(M' + (last + 1 + i) + '="AI Advanced Skill","BDG-AI-003","CHECK CATEGORY"))))';
    return o[f] == null ? "" : o[f];
  }));
  sh.getRange(last + 1, 1, rows.length, 20).setValues(values);
  return { ok: true, appended: rows.length };
}

// ---------------------------------------------------------------- sign-in codes
function roleOf_(email) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return null;
  if (email === ADMIN_EMAIL.toLowerCase()) return "admin";
  return readRows_().some((r) => r.email.toLowerCase() === email) ? "student" : null;
}

function sendCode_(email) {
  email = String(email || "").trim().toLowerCase();
  const role = roleOf_(email);
  if (!role) return { ok: false, error: "not_found" };
  const cache = CacheService.getScriptCache();
  if (cache.get("otp-wait:" + email)) return { ok: false, error: "wait" }; // one code per minute
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  cache.put("otp:" + email, JSON.stringify({ code: code, tries: 0 }), 600);
  cache.put("otp-wait:" + email, "1", 60);
  MailApp.sendEmail({
    to: email,
    subject: "BTU AI Skills Passport: შესვლის კოდი " + code,
    htmlBody:
      '<div style="font-family:Arial,sans-serif;max-width:480px">' +
      '<p style="font-size:13px;color:#6B7280;margin:0 0 6px">BTU · AI Skills Digital Passport</p>' +
      '<p style="font-size:16px;margin:0 0 14px">თქვენი ერთჯერადი შესვლის კოდი:</p>' +
      '<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:0 0 14px;color:#CC006F">' + code + "</p>" +
      '<p style="font-size:13px;color:#6B7280;margin:0">კოდი მოქმედებს 10 წუთი. თუ შესვლა თქვენ არ მოგითხოვიათ, უბრალოდ დააიგნორეთ ეს წერილი.</p></div>',
    name: "BTU AI Skills Passport",
  });
  return { ok: true, role: role };
}

function checkCode_(email, code) {
  email = String(email || "").trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const raw = cache.get("otp:" + email);
  if (!raw) return { ok: false, error: "expired" };
  const o = JSON.parse(raw);
  if (String(code || "").trim() !== o.code) {
    o.tries++;
    if (o.tries >= 5) { cache.remove("otp:" + email); return { ok: false, error: "too_many" }; }
    cache.put("otp:" + email, JSON.stringify(o), 600);
    return { ok: false, error: "wrong" };
  }
  cache.remove("otp:" + email);
  return { ok: true, role: roleOf_(email) };
}

// ---------------------------------------------------------------- passport e-mails
// Sent after a sync issues a new passport version. Only students that exist in the
// Sheet receive mail, so the endpoint cannot be used to e-mail arbitrary addresses.
function notify_(items) {
  const known = {};
  readRows_().forEach((r) => (known[r.email.toLowerCase()] = true));
  let sent = 0;
  items.slice(0, 200).forEach((it) => {
    const email = String(it.email || "").trim().toLowerCase();
    if (!known[email] || !/^BTUV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(String(it.code))) return;
    const url = String(it.verifyUrl || "");
    const qr = UrlFetchApp.fetch("https://quickchart.io/qr?size=220&margin=1&text=" + encodeURIComponent(url)).getBlob().setName("verify-qr.png");
    const skills = (it.newSkills || []).map((s) => "<li>" + esc_(s) + "</li>").join("");
    MailApp.sendEmail({
      to: email,
      subject: it.version === "V1" && !skills ? "თქვენი AI Skills Digital Passport შეიქმნა" : "თქვენს AI Skills Digital Passport-ს დაემატა ახალი უნარი",
      name: "BTU AI Skills Passport",
      htmlBody:
        '<div style="font-family:Arial,sans-serif;max-width:520px">' +
        '<p style="font-size:13px;color:#6B7280;margin:0 0 6px">BTU · AI Skills Digital Passport</p>' +
        "<h2 style=\"margin:0 0 12px\">გამარჯობა, " + esc_(it.name) + "!</h2>" +
        (skills ? "<p>თქვენს პასპორტს დაემატა:</p><ul>" + skills + "</ul>" : "<p>თქვენი ციფრული პასპორტი შეიქმნა. უნარები დაემატება ვორქშოფების, ჰაკათონებისა და კურსების დასრულების შემდეგ.</p>") +
        "<p><b>Passport ID:</b> " + esc_(it.passportId) + " · <b>ვერსია:</b> " + esc_(it.version) + "<br><b>ვერიფიკაციის კოდი:</b> " + esc_(it.code) + "</p>" +
        '<p><a href="' + esc_(url) + '" style="color:#CC006F">ვერიფიკაციის გვერდი</a> · ან დაასკანერეთ QR კოდი:</p><img src="cid:qr" width="160" height="160" alt="QR">' +
        '<p style="font-size:13px;color:#6B7280">PDF-ის ჩამოტვირთვა შეგიძლიათ საიტზე, BTU ელფოსტით შესვლის შემდეგ.</p></div>',
      inlineImages: { qr: qr },
    });
    sent++;
  });
  return { ok: true, sent: sent };
}

function esc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
