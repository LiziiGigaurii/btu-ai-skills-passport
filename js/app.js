/* BTU AI Skills Digital Passport: web app (public verification, student portal, administration, ledger). */
(function () {
  "use strict";

  const KEYS = { db: "btu-ap-db-v1", issuer: "btu-ap-issuer-v1", sheet: "btu-ap-sheet-v1", source: "btu-ap-source-v1" };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-"); return d + "." + m + "." + y; };
  const fmtDT = (iso) => iso ? fmtDate(iso) + " " + iso.slice(11, 16) + " UTC" : "—";
  const short = (h, n) => h ? h.slice(0, n || 12) + "…" + h.slice(-6) : "—";
  const CAT_COLOR = { "AI Skill": "var(--s-skill)", "AI Applied Skill": "var(--s-applied)", "AI Advanced Skill": "var(--s-adv)" };
  const cat = (c) => '<span class="cat"><i style="background:' + (CAT_COLOR[c] || "#999") + '"></i>' + esc(c) + "</span>";
  const statusPill = (s) => ({ "SYNCED": '<span class="pill ok">SYNCED</span>', "NOT SYNCED": '<span class="pill warn">NOT SYNCED</span>', "FAILED": '<span class="pill bad">FAILED</span>' }[s] || '<span class="pill grey">' + esc(s || "—") + "</span>");
  const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const bytesToB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

  let toastT;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3800); }

  // ------------------------------------------------------------ state
  let SQL, db, core, sheetRows, source;
  // One administrator account controls the Sheet, sync, passports and settings.
  const ADMIN_EMAIL = "admin@btu.edu.ge";
  let savedSession = null;
  try { savedSession = JSON.parse(sessionStorage.getItem("btu-ap-session") || "null"); } catch (e) {}
  const ui = { route: "verify", adminTab: "sheet", sheetFilter: "ALL", sheetSearch: "", lastSync: null, session: savedSession, otp: null, verify: null, busy: false, loginFor: null };
  function setSession(s) {
    ui.session = s;
    try { if (s) sessionStorage.setItem("btu-ap-session", JSON.stringify(s)); else sessionStorage.removeItem("btu-ap-session"); } catch (e) {}
  }
  function logout() {
    setSession(null); ui.otp = null; ui.lastSync = null;
    if (location.hash === "#verify") go(); else location.hash = "#verify";
    toast("გამოხვედით სისტემიდან");
  }

  function makeSqlAdapter(database) {
    return {
      exec: (q) => database.exec(q),
      run: (q, p) => database.run(q, p || []),
      all: (q, p) => {
        const st = database.prepare(q);
        try { st.bind(p || []); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
      },
    };
  }
  function persist() {
    store.set(KEYS.db, bytesToB64(db.export()));
    store.set(KEYS.sheet, JSON.stringify(sheetRows));
  }

  // Google Sheet sources. "demo" keeps the provided test sheet (A–T) in this browser;
  // "google" talks to the Apps Script web app bound to the real sheet (apps-script/Code.gs).
  function demoSource() {
    return {
      label: "სატესტო Google Sheet (Passport Skill Records)",
      read: async () => JSON.parse(JSON.stringify(sheetRows)),
      writeBack: async (updates) => { updates.forEach((u) => { const r = sheetRows.find((x) => x.recordId === u.recordId) || sheetRows[u.rowNo]; if (r) Object.assign(r, u.set); }); },
    };
  }
  function googleSource(url) {
    return {
      label: "Google Sheet (Apps Script)",
      read: async () => {
        const r = await fetch(url + (url.includes("?") ? "&" : "?") + "action=read");
        if (!r.ok) throw new Error("Google Sheet-მა უპასუხა შეცდომით: " + r.status);
        const j = await r.json();
        sheetRows = j.rows;
        return JSON.parse(JSON.stringify(j.rows));
      },
      writeBack: async (updates) => {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "writeBack", updates: updates.map((u) => ({ recordId: u.recordId, set: u.set })) }) });
        if (!r.ok) throw new Error("Google Sheet-ში ჩაწერა ვერ მოხერხდა: " + r.status);
        updates.forEach((u) => { const x = sheetRows.find((y) => y.recordId === u.recordId); if (x) Object.assign(x, u.set); });
      },
    };
  }
  function currentSource() {
    let cfg = null; try { cfg = JSON.parse(store.get(KEYS.source) || "null"); } catch (e) {}
    return cfg && cfg.mode === "google" && cfg.url ? Object.assign(googleSource(cfg.url), { mode: "google", url: cfg.url }) : Object.assign(demoSource(), { mode: "demo" });
  }

  async function boot() {
    if (!window.initSqlJs) throw new Error("SQL ბიბლიოთეკა (sql.js) ვერ ჩაიტვირთა. შეამოწმეთ ინტერნეტთან კავშირი.");
    SQL = await window.initSqlJs();
    const saved = store.get(KEYS.db);
    db = saved ? new SQL.Database(b64ToBytes(saved)) : new SQL.Database();
    try { sheetRows = JSON.parse(store.get(KEYS.sheet) || "null"); } catch (e) { sheetRows = null; }
    if (!Array.isArray(sheetRows)) sheetRows = JSON.parse(JSON.stringify(window.BTU_TEST_SHEET));
    else { // rows added to the test data after this browser saved its sheet
      const have = new Set(sheetRows.map((r) => r.recordId));
      window.BTU_TEST_SHEET.forEach((r) => { if (!have.has(r.recordId)) sheetRows.push(JSON.parse(JSON.stringify(r))); });
    }
    source = currentSource();
    const tpl = b64ToBytes(window.PASSPORT_TEMPLATE_B64);
    const sheetProxy = { get label() { return source.label; }, read: () => source.read(), writeBack: (u) => source.writeBack(u) };
    core = PassportCore.create({ sql: makeSqlAdapter(db), pdf: window.PassportPDF, template: tpl, sheet: sheetProxy, crypto: window.crypto });
    let key = null; try { key = JSON.parse(store.get(KEYS.issuer) || "null"); } catch (e) {}
    await core.init(key);
    if (!key) store.set(KEYS.issuer, JSON.stringify(await core.exportIssuerKey()));
    if (!saved) {
      $("boot").textContent = "პირველი გაშვება: Sheet-ში უკვე SYNCED ჩანაწერების V1 ვერსიები აღდგება…";
      if (source.mode === "demo") await core.importExistingIssuance();
      persist();
    } else if (source.mode === "demo") {
      core.stageSheet(sheetRows);
    }
  }

  async function resetDemo() {
    Object.values(KEYS).forEach((k) => store.del(k));
    sheetRows = JSON.parse(JSON.stringify(window.BTU_TEST_SHEET));
    db.close();
    db = new SQL.Database();
    source = currentSource();
    const tpl = b64ToBytes(window.PASSPORT_TEMPLATE_B64);
    const sheetProxy = { get label() { return source.label; }, read: () => source.read(), writeBack: (u) => source.writeBack(u) };
    core = PassportCore.create({ sql: makeSqlAdapter(db), pdf: window.PassportPDF, template: tpl, sheet: sheetProxy, crypto: window.crypto });
    await core.init(null);
    store.set(KEYS.issuer, JSON.stringify(await core.exportIssuerKey()));
    await core.importExistingIssuance();
    persist();
    Object.assign(ui, { lastSync: null, student: null, otp: null, verify: null });
  }

  // ------------------------------------------------------------ PDF helpers
  let pdfjs = null;
  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    const mod = await import(new URL("vendor/pdf.min.mjs", document.baseURI).href);
    mod.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", document.baseURI).href;
    pdfjs = mod;
    return mod;
  }
  async function renderPreview(container, bytes) {
    container.innerHTML = '<div class="skel"></div>';
    try {
      const lib = await loadPdfJs();
      const doc = await lib.getDocument({ data: bytes.slice(0) }).promise;
      container.innerHTML = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.setAttribute("aria-label", "პასპორტის გვერდი " + i);
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      }
    } catch (e) {
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      container.innerHTML = '<iframe title="პასპორტის PDF" src="' + url + '"></iframe><p class="hint">თუ PDF აქ არ ჩანს, ჩამოტვირთეთ ფაილი.</p>';
    }
  }
  async function saveFile(filename, bytes) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data: blob }); toast("ფაილი შენახულია: " + filename); }
      catch (e) { if (e && e.code !== "declined") toast("ჩამოტვირთვა ვერ მოხერხდა (" + (e.code || "error") + ")"); }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function downloadVersion(pid, v) {
    try { const bytes = await core.officialPdf(pid, v); await saveFile("BTU-AI-Skills-Passport_" + pid + "_V" + v + ".pdf", bytes); }
    catch (e) { toast(e.message); }
  }
  async function openPreviewModal(pid, v) {
    const p = core.q.passports().find((x) => x.passport_id === pid);
    const m = document.createElement("div");
    m.className = "modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
    m.innerHTML = '<div class="card edge stack"><div class="row between"><div><h2>' + esc(p.first_name + " " + p.last_name) + '</h2><div class="muted small">' + esc(pid) + " · V" + v + '</div></div><div class="row"><button class="btn primary sm" data-dl>PDF-ის ჩამოტვირთვა</button><button class="btn sm" data-close>დახურვა</button></div></div><div class="pages" data-pages></div></div>';
    document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    m.querySelector("[data-close]").onclick = close;
    m.querySelector("[data-dl]").onclick = () => downloadVersion(pid, v);
    m.querySelector("[data-close]").focus();
    renderPreview(m.querySelector("[data-pages]"), await core.officialPdf(pid, v));
  }

  // ------------------------------------------------------------ routing
  const ROUTES = { verify: renderVerify, student: renderStudent, admin: renderAdmin, ledger: renderLedger, login: renderLogin };
  function go() {
    const r = (location.hash || "#verify").slice(1);
    let route = ROUTES[r] ? r : "verify";
    const role = ui.session && ui.session.role;
    // Private pages need the matching sign-in: students see only their own passport, the admin sees administration.
    if (route === "admin" && role !== "admin") { ui.loginFor = "admin"; route = "login"; }
    else if (route === "student" && role !== "student") { ui.loginFor = role === "admin" ? null : "student"; route = role === "admin" ? "admin" : "login"; }
    else if (route === "login" && role) { route = role; }
    ui.route = route;
    renderNav();
    ROUTES[route]();
    window.scrollTo(0, 0);
  }
  function renderNav() {
    const role = ui.session && ui.session.role;
    const links = [["verify", "ვერიფიკაცია"], ["ledger", "ბლოკჩეინი"]];
    if (role === "student") links.push(["student", "ჩემი პასპორტი"]);
    if (role === "admin") links.push(["admin", "ადმინისტრირება"]);
    $("nav").innerHTML = links.map(([id, label]) => '<a href="#' + id + '" data-route="' + id + '"' + (ui.route === id ? ' aria-current="page"' : "") + ">" + label + "</a>").join("");
    $("session").innerHTML = role
      ? '<span class="who"><b>' + (role === "admin" ? "ადმინისტრატორი" : "სტუდენტი") + "</b>" + esc(ui.session.email) + '</span><button class="btn sm" id="nav-out" type="button">გასვლა</button>'
      : '<span class="proto">ჰაკათონის პროტოტიპი</span><a class="btn primary sm" href="#login"' + (ui.route === "login" ? ' aria-current="page"' : "") + ">შესვლა</a>";
    if ($("nav-out")) $("nav-out").onclick = logout;
  }
  window.addEventListener("hashchange", go);

  const CHEVRONS = '<svg class="chev" viewBox="0 0 400 520" aria-hidden="true" fill="none" stroke="#fff" stroke-width="34"><path d="M20 20 L200 200 L380 20"/><path d="M20 180 L200 360 L380 180"/><path d="M20 340 L200 520 L380 340"/></svg>';

  // ------------------------------------------------------------ verify (public)
  function renderVerify() {
    const samples = core.q.passports().filter((p) => p.verification_code).slice(0, 3);
    $("app").innerHTML =
      '<section class="hero">' + CHEVRONS + '<div class="wrap"><span class="eyebrow">Business &amp; Technology University</span>' +
        '<h1>AI Skills Digital Passport-ის ვერიფიკაცია</h1>' +
        '<p>შეიყვანეთ პასპორტის პირველ გვერდზე მითითებული ვერიფიკაციის კოდი. შემოწმება საჯაროა, რეგისტრაცია და ავტორიზაცია საჭირო არ არის.</p></div></section>' +
      '<div class="wrap stack">' +
        '<form class="card edge form lift" id="vf" novalidate>' +
          '<div class="inline-form"><label class="f" for="v-code">ვერიფიკაციის კოდი<input class="code" id="v-code" autocomplete="off" spellcheck="false" placeholder="BTUV-XXXX-XXXX-XXXX" value="' + esc(ui.verify && ui.verify.code || "") + '"></label>' +
          '<button class="btn primary" type="submit" id="v-go">შემოწმება</button></div>' +
          '<div class="or">და/ან</div>' +
          '<div class="drop"><label class="f" for="v-file" style="flex:1;min-width:220px">მიღებული PDF<span class="hint" style="font-weight:400">შემოწმდება, ზუსტად ემთხვევა თუ არა ფაილი ოფიციალურად გაცემულ ვერსიას</span></label><input type="file" id="v-file" accept="application/pdf,.pdf"></div>' +
          (samples.length ? '<p class="hint" style="margin:0">სატესტო კოდები: ' + samples.map((p) => '<button type="button" class="btn ghost sm mono" data-sample="' + esc(p.verification_code) + '">' + esc(p.verification_code) + "</button>").join(" ") + "</p>" : "") +
        "</form>" +
        '<div id="v-result" aria-live="polite"></div>' +
        howItWorks() +
      "</div>";
    const form = $("vf");
    form.onsubmit = async (e) => { e.preventDefault(); await runVerify(); };
    form.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = () => { $("v-code").value = b.dataset.sample; $("v-file").value = ""; runVerify(); }));
    if (ui.verify && ui.verify.result) showVerifyResult(ui.verify.result, ui.verify.file);
  }
  function howItWorks() {
    return '<div class="grid3">' +
      '<div class="card"><h3>1. ოფიციალურად გაცემული</h3><p class="muted small" style="margin:6px 0 0">პასპორტის ყოველი ვერსიის PDF-ის SHA-256 hash გაცემისთანავე იწერება ბლოკჩეინზე.</p></div>' +
      '<div class="card"><h3>2. შეუცვლელი</h3><p class="muted small" style="margin:6px 0 0">თუ PDF-ში შეიცვლება თუნდაც ერთი სიმბოლო (სახელი, უნარი, თარიღი), hash აღარ დაემთხვევა და ვერიფიკაცია ვერ გაივლის.</p></div>' +
      '<div class="card"><h3>3. გამცემი არის BTU</h3><p class="muted small" style="margin:6px 0 0">ჩანაწერი ხელმოწერილია BTU-ის ციფრული გასაღებით (did:web:btu.edu.ge). ხელმოწერა საჯარო გასაღებით მოწმდება.</p></div></div>';
  }
  async function runVerify() {
    const code = $("v-code").value.trim();
    const file = $("v-file").files[0];
    const out = $("v-result");
    if (!code && !file) { out.innerHTML = '<div class="notice bad">შეიყვანეთ ვერიფიკაციის კოდი ან ატვირთეთ PDF.</div>'; return; }
    out.innerHTML = '<div class="card muted">მოწმდება ბლოკჩეინის რეესტრში…</div>';
    let res;
    if (file) res = await core.verifyPdf(new Uint8Array(await file.arrayBuffer()), code || null);
    else res = await core.verifyCode(code);
    ui.verify = { code, result: res, file: file ? file.name : null };
    showVerifyResult(res, file ? file.name : null);
  }
  function showVerifyResult(res, fileName) {
    const out = $("v-result");
    if (!res.found) {
      out.innerHTML = '<div class="card stack"><div class="checks">' +
        '<div class="check bad"><span class="ic">✕</span><div><span class="lbl">დოკუმენტის ნამდვილობა</span><b>' + (fileName ? "PDF არ ემთხვევა ოფიციალურ ვერსიას" : "კოდი ვერ მოიძებნა") + "</b><p>" +
          (fileName ? "ატვირთული ფაილის hash ბლოკჩეინზე რეგისტრირებული არ არის. ფაილი შეცვლილია ან ოფიციალურად არ გაცემულა." : "ასეთი ვერიფიკაციის კოდით პასპორტი გაცემული არ არის. შეამოწმეთ კოდი.") + "</p></div></div>" +
        '<div class="check bad"><span class="ic">✕</span><div><span class="lbl">გამცემის ნამდვილობა</span><b>ვერ დადასტურდა</b><p>BTU-ის ხელმოწერილი ჩანაწერი არ არსებობს.</p></div></div></div>' +
        (fileName ? '<dl class="kv"><dt>ატვირთული ფაილი</dt><dd>' + esc(fileName) + '</dd><dt>ფაილის SHA-256</dt><dd class="mono">' + esc(res.docHash) + "</dd>" + (res.expected ? '<dt>ოფიციალური ვერსიის SHA-256</dt><dd class="mono">' + esc(res.expected.doc_sha256) + "</dd>" : "") + "</dl>" : "") + "</div>";
      return;
    }
    const d = res.data, v = res.version;
    const docOk = res.documentOk && (res.matchesCode !== false);
    const docText = fileName
      ? (res.matchesCode === false ? "ატვირთული PDF ნამდვილია, მაგრამ სხვა ვერსიას ეკუთვნის, ვიდრე შეყვანილი კოდი." : "ატვირთული PDF ბაიტ-ბაიტ ემთხვევა ოფიციალურად გაცემულ ვერსიას და არ შეცვლილა.")
      : "ვერსია ოფიციალურად გაცემულია და ბლოკჩეინზეა რეგისტრირებული. სრული შემოწმებისთვის ატვირთეთ მიღებული PDF.";
    out.innerHTML = '<div class="card edge stack">' +
      '<div class="checks">' +
        '<div class="check ' + (docOk ? "ok" : "bad") + '"><span class="ic">' + (docOk ? "✓" : "✕") + '</span><div><span class="lbl">დოკუმენტის ნამდვილობა</span><b>' + (docOk ? "ნამდვილი და შეუცვლელი" : "ვერ დადასტურდა") + "</b><p>" + docText + "</p></div></div>" +
        '<div class="check ' + (res.issuerOk ? "ok" : "bad") + '"><span class="ic">' + (res.issuerOk ? "✓" : "✕") + '</span><div><span class="lbl">გამცემის ნამდვილობა</span><b>' + (res.issuerOk ? "გამცემი: BTU" : "ხელმოწერა არასწორია") + "</b><p>" + (res.issuerOk ? "ჩანაწერი ხელმოწერილია " + esc(res.issuer.name) + "-ის გასაღებით · " + esc(res.issuer.did) : "ჩანაწერის ხელმოწერა BTU-ის რეგისტრირებულ გასაღებს არ ემთხვევა.") + "</p></div></div>" +
      "</div>" +
      (res.isLatest ? '<div class="row"><span class="pill ok">უახლესი მოქმედი ვერსია</span></div>'
        : '<div class="notice">ეს ' + esc("V" + v.version) + ' ნამდვილი, მაგრამ ჩანაცვლებული ვერსიაა. პასპორტის უახლესი ვერსიაა V' + res.latest.version + ' (კოდი: <span class="mono">' + esc(res.latest.verification_code) + "</span>).</div>") +
      '<div class="grid2"><div class="stack" style="gap:12px"><h3>პასპორტი</h3><dl class="kv">' +
        "<dt>მფლობელი</dt><dd>" + esc(d.firstName + " " + d.lastName) + "</dd>" +
        '<dt>Passport ID</dt><dd class="mono">' + esc(d.passportId) + "</dd>" +
        "<dt>ვერსია</dt><dd>" + esc(d.version) + " · გაცემულია " + fmtDT(v.issued_at) + "</dd>" +
        "<dt>პირველი გაცემა</dt><dd>" + fmtDate(d.firstIssued) + "</dd>" +
        '<dt>ვერიფიკაციის კოდი</dt><dd class="mono">' + esc(v.verification_code) + "</dd>" +
      "</dl></div>" +
      '<div class="stack" style="gap:12px"><h3>ბლოკჩეინის ჩანაწერი</h3><dl class="kv">' +
        '<dt>PDF SHA-256</dt><dd class="mono">' + esc(v.doc_sha256) + "</dd>" +
        "<dt>ბლოკი</dt><dd>#" + v.block_index + " · " + fmtDT(res.block.created_at) + "</dd>" +
        '<dt>ტრანზაქცია</dt><dd class="mono">' + esc(short(v.tx_hash, 18)) + "</dd>" +
        '<dt>გასაღების ანაბეჭდი</dt><dd class="mono">' + esc(res.issuer.fingerprint) + "</dd>" +
        "<dt>რეესტრის მთლიანობა</dt><dd>" + (res.chain.ok ? '<span class="pill ok">' + res.chain.length + " ბლოკი, მთელია</span>" : '<span class="pill bad">დაზიანებულია</span>') + "</dd>" +
      "</dl></div></div>" +
      "<div><h3>დადასტურებული უნარები (" + d.skills.length + ')</h3><div class="tbl" style="margin-top:10px"><table><thead><tr><th>უნარი</th><th>ტიპი</th><th>აღწერა</th><th>მიღების თარიღი</th></tr></thead><tbody>' +
        d.skills.map((s) => "<tr><td><b>" + esc(s.name) + "</b></td><td>" + cat(s.category) + '</td><td class="small">' + esc(s.description) + '</td><td class="num">' + fmtDate(s.dateEarned) + "</td></tr>").join("") +
      "</tbody></table></div></div>" +
      '<div class="row"><button class="btn primary" id="v-dl">ოფიციალური PDF-ის ჩამოტვირთვა</button><span class="hint">ჩამოტვირთული ფაილის hash ემთხვევა ბლოკჩეინზე რეგისტრირებულს.</span></div>' +
    "</div>";
    $("v-dl").onclick = () => downloadVersion(d.passportId, v.version);
  }

  // ------------------------------------------------------------ student portal
  function renderStudent() {
    if (!ui.session || ui.session.role !== "student") return renderLogin();
    const email = ui.session.email;
    const p = core.q.passportByEmail(email);
    const s = core.q.studentByEmail(email);
    if (!p) {
      $("app").innerHTML = '<div class="wrap page-head"><h1>ჩემი პასპორტი</h1></div><div class="wrap stack"><div class="card edge stack"><h2>' + esc(s.first_name + " " + s.last_name) + '</h2><div class="notice">თქვენი Digital Passport ჯერ არ გაცემულა. ის ავტომატურად შეიქმნება, როცა BTU თქვენს დადასტურებულ უნარს სისტემაში დაასინქრონებს.</div><div><button class="btn" id="s-out">გასვლა</button></div></div></div>';
      $("s-out").onclick = logout;
      return;
    }
    const versions = core.q.versions(p.passport_id);
    const latest = versions[0];
    $("app").innerHTML =
      '<div class="wrap page-head"><h1>ჩემი პასპორტი</h1><p>თქვენი AI Skills Digital Passport. Passport ID მუდმივია, ახალი უნარის დამატებისას კი იქმნება ახალი ვერსია.</p></div>' +
      '<div class="wrap stack">' +
        '<div class="card edge"><div class="grid2" style="align-items:start">' +
          '<div class="stack" style="gap:10px"><h2>' + esc(p.first_name + " " + p.last_name) + "</h2>" +
            '<dl class="kv"><dt>Passport ID</dt><dd class="mono">' + esc(p.passport_id) + "</dd><dt>პირველი გაცემა</dt><dd>" + fmtDate(p.first_issued) + "</dd><dt>პროგრამა</dt><dd>" + esc(p.program) + " · " + esc(p.education_level) + "</dd><dt>ელფოსტა</dt><dd>" + esc(p.email) + "</dd></dl></div>" +
          '<div class="stack" style="gap:10px"><div class="row"><span class="pill ok">უახლესი ვერსია: V' + latest.version + '</span><span class="pill grey">' + latest.skills_count + " უნარი</span></div>" +
            '<dl class="kv"><dt>ვერიფიკაციის კოდი</dt><dd class="mono">' + esc(latest.verification_code) + "</dd><dt>გაცემულია</dt><dd>" + fmtDT(latest.issued_at) + "</dd></dl>" +
            '<div class="row"><button class="btn primary" id="s-dl">PDF-ის ჩამოტვირთვა</button><button class="btn" id="s-copy">კოდის კოპირება</button><button class="btn ghost" id="s-out">გასვლა</button></div>' +
            '<p class="hint" style="margin:0">დამსაქმებელს გაუზიარეთ PDF ან ვერიფიკაციის კოდი. შემოწმება შესაძლებელია „ვერიფიკაციის“ გვერდზე, ავტორიზაციის გარეშე.</p></div>' +
        "</div></div>" +
        '<div class="card stack"><h2>პასპორტი (V' + latest.version + ')</h2><div class="pages" id="s-pages"></div></div>' +
        '<div class="card stack"><h2>ვერსიების ისტორია</h2><div class="tbl"><table><thead><tr><th>ვერსია</th><th>გაცემის დრო</th><th>უნარები</th><th>ვერიფიკაციის კოდი</th><th>სტატუსი</th><th></th></tr></thead><tbody>' +
          versions.map((v) => '<tr><td><b>V' + v.version + '</b></td><td class="num">' + fmtDT(v.issued_at) + '</td><td class="num">' + v.skills_count + '</td><td class="mono">' + esc(v.verification_code) + "</td><td>" + (v.status === "LATEST" ? '<span class="pill ok">უახლესი</span>' : '<span class="pill grey">ჩანაცვლებული</span>') + '</td><td><button class="btn sm" data-v="' + v.version + '">ჩამოტვირთვა</button></td></tr>').join("") +
        "</tbody></table></div></div>" +
      "</div>";
    $("s-dl").onclick = () => downloadVersion(p.passport_id, latest.version);
    $("s-out").onclick = logout;
    $("s-copy").onclick = async () => { try { await navigator.clipboard.writeText(latest.verification_code); toast("კოდი დაკოპირდა"); } catch (e) { toast("კოპირება ვერ მოხერხდა: " + latest.verification_code); } };
    document.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => downloadVersion(p.passport_id, Number(b.dataset.v))));
    core.officialPdf(p.passport_id, latest.version).then((bytes) => renderPreview($("s-pages"), bytes)).catch((e) => ($("s-pages").innerHTML = '<div class="notice bad">' + esc(e.message) + "</div>"));
  }
  function renderLogin() {
    const sample = core.q.passports().slice(0, 3).map((p) => p.email);
    const otp = ui.otp;
    const forAdmin = ui.loginFor === "admin";
    $("app").innerHTML =
      '<div class="wrap page-head"><h1>შესვლა</h1><p>' + (forAdmin
        ? "ადმინისტრირების გვერდი მხოლოდ ადმინისტრატორისთვისაა. შედით ადმინისტრატორის ელფოსტით."
        : "სტუდენტები შედიან BTU-ის ელფოსტით და ხედავენ მხოლოდ საკუთარ პასპორტს. პასპორტის ვერიფიკაციისთვის შესვლა საჭირო არ არის.") + "</p></div>" +
      '<div class="wrap"><div class="card edge form" style="max-width:520px">' +
        (!otp
          ? '<form class="form" id="l1" novalidate><label class="f" for="l-email">BTU ელფოსტა<input id="l-email" type="email" autocomplete="email" placeholder="name.surname@btu.edu.ge"></label><p class="notice bad" id="l-err" hidden></p><button class="btn primary" type="submit">ერთჯერადი კოდის გაგზავნა</button>' +
            '<p class="hint" style="margin:0">სატესტო სტუდენტები: ' + sample.map((e) => '<button type="button" class="btn ghost sm" data-email="' + esc(e) + '">' + esc(e) + "</button>").join(" ") +
            '<br>ადმინისტრატორი: <button type="button" class="btn ghost sm" data-email="' + ADMIN_EMAIL + '">' + ADMIN_EMAIL + "</button></p></form>"
          : '<form class="form" id="l2" novalidate><p style="margin:0">კოდი გაიგზავნა მისამართზე <b>' + esc(otp.email) + '</b>.</p><div class="notice info">სატესტო რეჟიმი: ელფოსტის სერვისი ჩართული არ არის, ამიტომ კოდი აქ ჩანს: <b class="mono">' + otp.code + '</b></div><label class="f" for="l-otp">6-ნიშნა კოდი<input id="l-otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" class="code"></label><p class="notice bad" id="l-err" hidden></p><div class="row"><button class="btn primary" type="submit">შესვლა</button><button class="btn ghost" type="button" id="l-back">სხვა ელფოსტა</button></div></form>') +
      "</div></div>";
    if (!otp) {
      const sendCode = (email) => {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("შეიყვანეთ სწორი ელფოსტა.");
        const isAdmin = email === ADMIN_EMAIL;
        const s = isAdmin ? null : core.q.studentByEmail(email);
        if (!isAdmin && !s) return fail("ეს ელფოსტა BTU-ის სტუდენტების სიაში ვერ მოიძებნა.");
        const a = new Uint32Array(1); crypto.getRandomValues(a);
        ui.otp = { email: isAdmin ? ADMIN_EMAIL : s.email, role: isAdmin ? "admin" : "student", code: String(a[0] % 1000000).padStart(6, "0"), exp: Date.now() + 10 * 60 * 1000, tries: 0 };
        renderLogin();
      };
      const fail = (m) => { const e = $("l-err"); e.textContent = m; e.hidden = false; };
      $("l1").onsubmit = (e) => { e.preventDefault(); sendCode($("l-email").value.trim().toLowerCase()); };
      document.querySelectorAll("[data-email]").forEach((b) => (b.onclick = () => { $("l-email").value = b.dataset.email; sendCode(b.dataset.email); }));
    } else {
      $("l-otp").focus();
      $("l-back").onclick = () => { ui.otp = null; renderLogin(); };
      $("l2").onsubmit = (e) => {
        e.preventDefault();
        const err = $("l-err");
        if (Date.now() > otp.exp) { ui.otp = null; renderLogin(); toast("კოდს ვადა გაუვიდა, მოითხოვეთ ახალი"); return; }
        if ($("l-otp").value.trim() !== otp.code) { otp.tries++; err.textContent = otp.tries >= 5 ? "ძალიან ბევრი მცდელობა. მოითხოვეთ ახალი კოდი." : "კოდი არასწორია."; err.hidden = false; if (otp.tries >= 5) { ui.otp = null; setTimeout(renderLogin, 1200); } return; }
        setSession({ email: otp.email, role: otp.role }); ui.otp = null; ui.loginFor = null;
        const target = "#" + otp.role;
        if (location.hash === target) go(); else location.hash = target;
      };
    }
  }

  // ------------------------------------------------------------ admin
  function renderAdmin() {
    const rows = core.q.sheetRows();
    const counts = rows.reduce((m, r) => (m[r.sync_status] = (m[r.sync_status] || 0) + 1, m), {});
    const pending = (counts["NOT SYNCED"] || 0) + (counts["FAILED"] || 0);
    const c = core.q.counts();
    const runs = core.q.runs();
    $("app").innerHTML =
      '<div class="wrap page-head"><h1>ადმინისტრირება</h1><p>მონაცემების წყაროა Google Sheet „Passport Skill Records“. ახალი დადასტურებული უნარი Sheet-ში ემატება, სისტემა კი ცვლილებას SQL მოთხოვნით აღმოაჩენს, სტუდენტის არსებულ პასპორტს ანახლებს და სტატუსს Sheet-ში უკან წერს.</p></div>' +
      '<div class="wrap stack">' +
        '<div class="grid4"><div class="stat"><b>' + c.passports + '</b><span>გაცემული პასპორტი</span></div><div class="stat"><b>' + c.versions + '</b><span>ვერსია ბლოკჩეინზე</span></div><div class="stat hot"><b>' + (counts["NOT SYNCED"] || 0) + '</b><span>NOT SYNCED ჩანაწერი Sheet-ში</span></div><div class="stat"><b>' + (counts["FAILED"] || 0) + '</b><span>FAILED (ხელახლა ცდა)</span></div></div>' +
        '<div class="card edge stack"><div class="row between" style="align-items:flex-start"><div><h2>Google Sheet → SQL → პასპორტი → ბლოკჩეინი</h2><p class="muted small" style="margin:4px 0 0">წყარო: ' + esc(source.label) + (runs[0] ? " · ბოლო სინქრონიზაცია: " + fmtDT(runs[0].started_at) : "") + '</p></div><button class="btn primary" id="a-sync"' + (pending ? "" : " disabled") + ">სინქრონიზაცია (" + pending + ")</button></div>" +
          '<div id="a-syncres">' + (ui.lastSync ? syncResultHtml(ui.lastSync) : '<p class="muted small" style="margin:0">' + (pending ? "Sheet-ში " + pending + " ჩანაწერი ელოდება დამუშავებას." : "ყველა ჩანაწერი დასინქრონებულია.") + "</p>") + "</div>" +
        "</div>" +
        '<div><div class="tabs" role="tablist">' +
          tabBtn("sheet", "Google Sheet (A–T)") + tabBtn("passports", "პასპორტები (" + c.passports + ")") + tabBtn("runs", "სინქრონიზაციის ისტორია") + tabBtn("source", "წყაროს პარამეტრები") +
        '</div><div id="a-tab"></div></div>' +
      "</div>";
    $("a-sync").onclick = doSync;
    document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { ui.adminTab = b.dataset.tab; renderAdmin(); }));
    ({ sheet: tabSheet, passports: tabPassports, runs: tabRuns, source: tabSource })[ui.adminTab]();
  }
  const tabBtn = (id, label) => '<button class="tab" role="tab" data-tab="' + id + '" aria-selected="' + (ui.adminTab === id) + '">' + label + "</button>";

  async function doSync() {
    const b = $("a-sync"); b.disabled = true; b.textContent = "მიმდინარეობს…";
    try {
      const res = await core.sync();
      persist();
      ui.lastSync = res;
      toast("სინქრონიზაცია დასრულდა: " + res.issued.length + " პასპორტი განახლდა");
    } catch (e) { toast("შეცდომა: " + e.message); }
    renderAdmin();
  }
  function syncResultHtml(r) {
    return '<div class="stack" style="gap:12px">' +
      '<div class="row"><span class="pill ok">' + r.synced + ' ჩანაწერი SYNCED</span><span class="pill pink">' + r.issued.length + ' პასპორტის ვერსია გაიცა</span>' + (r.failed ? '<span class="pill bad">' + r.failed + " FAILED</span>" : "") + "</div>" +
      '<ol class="steps">' + r.log.steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
      (r.log.failed.length ? '<div class="notice bad">' + r.log.failed.map((f) => esc(f.recordId + ": " + f.error)).join("<br>") + "</div>" : "") +
      '<details class="sql"><summary>შესრულებული SQL მოთხოვნები (' + r.log.sql.length + ")</summary><pre>" + esc(r.log.sql.join(";\n\n")) + ";</pre></details></div>";
  }

  function tabSheet() {
    const rows = core.q.sheetRows();
    const f = ui.sheetFilter, q = ui.sheetSearch.toLowerCase();
    const list = rows.filter((r) => (f === "ALL" || r.sync_status === f) && (!q || (r.student_id + " " + r.first_name + " " + r.last_name + " " + r.email + " " + r.record_id + " " + r.skill_name + " " + r.passport_id).toLowerCase().includes(q)));
    const cols = [["A", "Student ID", "student_id"], ["B", "First Name", "first_name"], ["C", "Last Name", "last_name"], ["D", "BTU Email", "email"], ["E", "Program", "program"], ["F", "Level", "education_level"], ["G", "Passport ID", "passport_id"], ["H", "First Issued", "first_issued"], ["I", "Status", "student_status"], ["J", "Record ID", "record_id"], ["K", "Skill ID", "skill_id"], ["L", "Skill Name", "skill_name"], ["M", "Category", "category"], ["N", "Badge Code", "badge_code"], ["O", "Description", "description"], ["P", "Date Earned", "date_earned"], ["Q", "Sync Status", "sync_status"], ["R", "Version", "synced_version"], ["S", "Synced At", "synced_at"], ["T", "Error / Notes", "sync_error"]];
    $("a-tab").innerHTML = '<div class="stack">' +
      (source.mode === "demo" ? addRecordHtml() : '<div class="notice info">წყაროა რეალური Google Sheet. ახალი უნარი პირდაპირ Sheet-ში დაამატეთ და დააჭირეთ „სინქრონიზაციას“.</div>') +
      '<div class="row between"><div class="chips" role="group" aria-label="ფილტრი">' + ["ALL", "NOT SYNCED", "SYNCED", "FAILED"].map((k) => '<button class="chip" data-f="' + k + '" aria-pressed="' + (f === k) + '">' + (k === "ALL" ? "ყველა" : k) + "</button>").join("") + '</div><input id="a-search" style="max-width:280px" placeholder="ძებნა: სახელი, Record ID, უნარი…" value="' + esc(ui.sheetSearch) + '"></div>' +
      '<div class="tbl tall"><table class="sheet"><thead><tr>' + cols.map((c) => '<th class="' + ("QRST".includes(c[0]) ? "sys" : "") + '"><span class="col">' + c[0] + "</span>" + c[1] + "</th>").join("") + "</tr></thead><tbody>" +
        (list.length ? list.map((r) => "<tr>" + cols.map((c) => { const v = r[c[2]]; const cls = ("QRST".includes(c[0]) ? "sys " : "") + (c[0] === "O" || c[0] === "T" ? "wrap" : ""); return '<td class="' + cls + '">' + (c[0] === "Q" ? statusPill(v) : c[0] === "M" ? cat(v) : esc(v)) + "</td>"; }).join("") + "</tr>").join("") : '<tr><td colspan="20" class="muted">ჩანაწერი ვერ მოიძებნა.</td></tr>') +
      '</tbody></table></div><p class="hint" style="margin:0">A–P: BTU-ის მიერ დადასტურებული მონაცემები · Q–T: სისტემის მიერ ჩაწერილი სტატუსი (ვარდისფერი სვეტები) · N გამოითვლება M-დან.</p></div>';
    document.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { ui.sheetFilter = b.dataset.f; tabSheet(); }));
    const s = $("a-search");
    s.oninput = () => { ui.sheetSearch = s.value; const pos = s.selectionStart; tabSheet(); const s2 = $("a-search"); s2.focus(); s2.setSelectionRange(pos, pos); };
    if (source.mode === "demo") bindAddRecord();
  }
  function addRecordHtml() {
    const students = core.q.students(), skills = core.q.skills();
    const today = new Date().toISOString().slice(0, 10);
    const groups = ["AI Skill", "AI Applied Skill", "AI Advanced Skill"];
    return '<details class="card" id="add-rec"' + (ui.addOpen ? " open" : "") + '><summary style="cursor:pointer;font-weight:700">+ ახალი დადასტურებული უნარის დამატება Sheet-ში</summary>' +
      '<form class="form" id="ar" novalidate style="margin-top:14px"><p class="hint" style="margin:0">ასე ამატებს ადმინისტრატორი ახალ სტრიქონს Google Sheet-ში. სტატუსი იქნება NOT SYNCED, სანამ სისტემა არ დაასინქრონებს.</p>' +
      '<div class="grid3"><label class="f" for="ar-st">სტუდენტი<select id="ar-st"><option value="__new">+ ახალი სტუდენტი</option>' + students.map((s) => '<option value="' + esc(s.student_id) + '"' + (s.student_id === ui.addStudent ? " selected" : "") + ">" + esc(s.student_id + " · " + s.first_name + " " + s.last_name) + "</option>").join("") + "</select></label>" +
      '<label class="f" for="ar-sk">უნარი<select id="ar-sk">' + groups.map((g) => '<optgroup label="' + g + '">' + skills.filter((s) => s.category === g).map((s) => '<option value="' + esc(s.skill_id) + '">' + esc(s.skill_id + " · " + s.name) + "</option>").join("") + "</optgroup>").join("") + "</select></label>" +
      '<label class="f" for="ar-dt">Date Earned<input type="date" id="ar-dt" value="' + today + '"></label></div>' +
      '<div class="grid3" id="ar-new"' + (ui.addStudent && ui.addStudent !== "__new" ? " hidden" : "") + '><label class="f" for="ar-fn">First Name<input id="ar-fn"></label><label class="f" for="ar-ln">Last Name<input id="ar-ln"></label><label class="f" for="ar-em">BTU Email<input id="ar-em" type="email" placeholder="name.surname@btu.edu.ge"></label>' +
      '<label class="f" for="ar-pr">Program<input id="ar-pr" placeholder="მაგ. Digital Marketing"></label><label class="f" for="ar-lv">Education Level<select id="ar-lv"><option>Bachelor\'s</option><option>Master\'s</option><option>Doctoral</option></select></label><p class="hint" style="margin:0;align-self:end">Passport ID-ს სისტემა თავად მიანიჭებს და Sheet-ში ჩაწერს.</p></div>' +
      '<p class="notice bad" id="ar-err" hidden></p><div><button class="btn primary" type="submit">სტრიქონის დამატება</button></div></form></details>';
  }
  function bindAddRecord() {
    const det = $("add-rec"); det.ontoggle = () => (ui.addOpen = det.open);
    const sel = $("ar-st");
    if (!ui.addStudent) ui.addStudent = sel.value;
    sel.onchange = () => { ui.addStudent = sel.value; $("ar-new").hidden = sel.value !== "__new"; };
    $("ar").onsubmit = (e) => {
      e.preventDefault();
      const err = $("ar-err"), fail = (m) => { err.textContent = m; err.hidden = false; };
      const sk = core.q.skills().find((s) => s.skill_id === $("ar-sk").value);
      const date = $("ar-dt").value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("მიუთითეთ თარიღი.");
      let base;
      if (sel.value === "__new") {
        const fn = $("ar-fn").value.trim(), ln = $("ar-ln").value.trim(), em = $("ar-em").value.trim().toLowerCase(), pr = $("ar-pr").value.trim();
        if (!fn || !ln || !pr) return fail("შეავსეთ სახელი, გვარი და პროგრამა.");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return fail("ელფოსტა არასწორია.");
        if (sheetRows.some((r) => r.email.toLowerCase() === em)) return fail("ამ ელფოსტით სტუდენტი უკვე არსებობს.");
        const maxId = sheetRows.reduce((m, r) => Math.max(m, Number(r.studentId.replace(/\D/g, "")) || 0), 0);
        base = { studentId: "BTU-T-" + String(maxId + 1).padStart(4, "0"), firstName: fn, lastName: ln, email: em, program: pr, educationLevel: $("ar-lv").value, passportId: "", firstIssued: "", studentStatus: "Active" };
      } else {
        const src = sheetRows.find((r) => r.studentId === sel.value);
        if (sheetRows.some((r) => r.studentId === sel.value && r.skillId === sk.skill_id)) return fail("ამ სტუდენტს ეს უნარი უკვე აქვს.");
        base = { studentId: src.studentId, firstName: src.firstName, lastName: src.lastName, email: src.email, program: src.program, educationLevel: src.educationLevel, passportId: src.passportId, firstIssued: src.firstIssued, studentStatus: src.studentStatus };
      }
      const maxRec = sheetRows.reduce((m, r) => Math.max(m, Number(r.recordId.replace(/\D/g, "")) || 0), 0);
      const row = Object.assign(base, { recordId: "REC-" + String(maxRec + 1).padStart(4, "0"), skillId: sk.skill_id, skillName: sk.name, category: sk.category, badgeCode: "", description: sk.description, dateEarned: date, syncStatus: "NOT SYNCED", syncedVersion: "", syncedAt: "", syncError: "" });
      sheetRows.push(row);
      core.stageSheet(sheetRows);
      persist();
      ui.sheetFilter = "ALL"; ui.lastSync = null;
      toast("Sheet-ს დაემატა " + row.recordId + " (NOT SYNCED)");
      renderAdmin();
    };
  }
  function tabPassports() {
    const list = core.q.passports();
    $("a-tab").innerHTML = '<div class="tbl"><table><thead><tr><th>Passport ID</th><th>სტუდენტი</th><th>პროგრამა</th><th>პირველი გაცემა</th><th>უახლესი</th><th>უნარები</th><th>ვერიფიკაციის კოდი</th><th></th></tr></thead><tbody>' +
      list.map((p) => '<tr><td class="mono">' + esc(p.passport_id) + "</td><td><b>" + esc(p.first_name + " " + p.last_name) + '</b><br><span class="muted small">' + esc(p.email) + '</span></td><td class="small">' + esc(p.program) + '</td><td class="num">' + fmtDate(p.first_issued) + '</td><td><span class="pill ok">V' + p.latest_version + '</span><br><span class="muted small num">' + fmtDT(p.latest_issued_at) + '</span></td><td class="num">' + p.skills_count + '</td><td class="mono">' + esc(p.verification_code) + '</td><td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-pv="' + esc(p.passport_id) + '|' + p.latest_version + '">ნახვა</button><button class="btn sm" data-pd="' + esc(p.passport_id) + "|" + p.latest_version + '">PDF</button></div></td></tr>').join("") +
      "</tbody></table></div>";
    document.querySelectorAll("[data-pv]").forEach((b) => (b.onclick = () => { const [pid, v] = b.dataset.pv.split("|"); openPreviewModal(pid, Number(v)); }));
    document.querySelectorAll("[data-pd]").forEach((b) => (b.onclick = () => { const [pid, v] = b.dataset.pd.split("|"); downloadVersion(pid, Number(v)); }));
  }
  function tabRuns() {
    const runs = core.q.runs();
    $("a-tab").innerHTML = runs.length ? '<div class="stack">' + runs.map((r) => { const log = JSON.parse(r.log || "{}"); return '<div class="card stack" style="gap:10px"><div class="row between"><b>სინქრონიზაცია #' + r.run_id + " · " + fmtDT(r.started_at) + '</b><div class="row"><span class="pill grey">წაკითხულია ' + r.rows_read + '</span><span class="pill ok">SYNCED ' + r.rows_synced + '</span><span class="pill pink">პასპორტი ' + r.passports_updated + "</span>" + (r.rows_failed ? '<span class="pill bad">FAILED ' + r.rows_failed + "</span>" : "") + '</div></div><ol class="steps">' + (log.steps || []).map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol></div>"; }).join("") + "</div>"
      : '<div class="card muted">სინქრონიზაცია ჯერ არ გაშვებულა. საწყისი V1 ვერსიები აღდგა Sheet-ის SYNCED ჩანაწერებიდან.</div>';
  }
  function tabSource() {
    $("a-tab").innerHTML = '<div class="grid2" style="align-items:start"><form class="card form" id="src" novalidate><h3>Google Sheet-ის დაკავშირება</h3>' +
      '<p class="muted small" style="margin:0">რეალური Sheet უკავშირდება Google Apps Script-ით (<span class="mono">apps-script/Code.gs</span>): ის აბრუნებს A–T სვეტებს და იღებს Q–T ჩანაწერებს. გაშვების ინსტრუქცია README-შია.</p>' +
      '<label class="row small" style="gap:8px"><input type="radio" name="mode" value="demo"' + (source.mode === "demo" ? " checked" : "") + ' style="width:auto"> სატესტო მონაცემები (BTU-ის მიერ მოწოდებული Sheet, ' + sheetRows.length + " ჩანაწერი)</label>" +
      '<label class="row small" style="gap:8px"><input type="radio" name="mode" value="google"' + (source.mode === "google" ? " checked" : "") + ' style="width:auto"> რეალური Google Sheet (Apps Script Web App URL)</label>' +
      '<label class="f" for="src-url">Web App URL<input id="src-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(source.url || "") + '"></label>' +
      '<p class="notice bad" id="src-err" hidden></p><div><button class="btn primary" type="submit">შენახვა</button></div></form>' +
      '<div class="card stack"><h3>მასშტაბირება და ავტომატიზაცია</h3><ul class="steps" style="padding-left:18px"><li>ერთი სინქრონიზაცია ამუშავებს ყველა ახალ სტრიქონს და თითო სტუდენტზე ქმნის ერთ ახალ ვერსიას.</li><li>იმპორტი იდემპოტენტურია: Record ID ერთხელ მუშავდება, FAILED ჩანაწერები შემდეგ ჯერზე თავიდან მოწმდება.</li><li>PDF დეტერმინისტულია: ფაილები ბაზაში არ ინახება და ნებისმიერ დროს ზუსტად აღდგება hash-ის შემოწმებით.</li><li>რეალურ სისტემაში სინქრონიზაცია ავტომატურად გაეშვება Sheet-ის ცვლილებისას (Apps Script trigger) ან განრიგით.</li></ul>' +
      '<div class="row"><button class="btn danger sm" id="reset" type="button">დემოს თავიდან დაწყება</button></div><div id="reset-confirm"></div></div></div>';
    $("src").onsubmit = async (e) => {
      e.preventDefault();
      const mode = document.querySelector('input[name="mode"]:checked').value, url = $("src-url").value.trim();
      if (mode === "google" && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { const er = $("src-err"); er.textContent = "მიუთითეთ Apps Script Web App-ის მისამართი (https://script.google.com/macros/s/…/exec)."; er.hidden = false; return; }
      store.set(KEYS.source, JSON.stringify({ mode, url }));
      source = currentSource();
      toast(mode === "google" ? "წყარო: რეალური Google Sheet" : "წყარო: სატესტო მონაცემები");
      renderAdmin();
    };
    $("reset").onclick = () => {
      $("reset-confirm").innerHTML = '<div class="notice bad">წაიშლება ყველა გაცემული ვერსია და ბლოკი, Sheet დაბრუნდება საწყის მდგომარეობაში. <div class="row" style="margin-top:8px"><button class="btn sm danger" id="reset-yes" type="button">თავიდან დაწყება</button><button class="btn sm" id="reset-no" type="button">გაუქმება</button></div></div>';
      $("reset-no").onclick = () => ($("reset-confirm").innerHTML = "");
      $("reset-yes").onclick = async () => { $("reset-yes").disabled = true; await resetDemo(); toast("დემო თავიდან დაიწყო"); ui.adminTab = "sheet"; renderAdmin(); };
    };
  }

  // ------------------------------------------------------------ ledger
  async function renderLedger() {
    const issuer = core.registeredIssuer();
    const chain = await core.checkChain();
    const blocks = core.q.ledger();
    $("app").innerHTML =
      '<div class="wrap page-head"><h1>ბლოკჩეინის რეესტრი</h1><p>პასპორტის ყოველი გაცემული ვერსიის PDF hash და BTU-ის ხელმოწერა. ბლოკები ერთმანეთზეა გადაბმული: ძველი ჩანაწერის შეცვლა მთელ ჯაჭვს არღვევს.</p></div>' +
      '<div class="wrap stack"><div class="grid2">' +
        '<div class="card edge stack" style="gap:10px"><h2>გამცემი (Issuer)</h2><dl class="kv"><dt>დასახელება</dt><dd>' + esc(issuer.name) + '</dd><dt>DID</dt><dd class="mono">' + esc(issuer.did) + '</dd><dt>საჯარო გასაღები</dt><dd class="mono">ECDSA P-256 · ' + esc(issuer.fingerprint) + "</dd><dt>რეგისტრაცია</dt><dd>ბლოკი #0</dd></dl>" +
          '<p class="hint" style="margin:0">მესამე მხარე ხელმოწერას ამ საჯარო გასაღებით ამოწმებს. საწარმოო ვერსიაში გასაღები გამოქვეყნდება მისამართზე btu.edu.ge/.well-known/did.json, ხოლო smart contract-ში ჩაწერის უფლება მხოლოდ BTU-ის მისამართს ექნება.</p></div>' +
        '<div class="card stack" style="gap:10px"><h2>ქსელი</h2><dl class="kv"><dt>პროტოტიპი</dt><dd>ბრაუზერში სიმულირებული ბლოკჩეინი (SHA-256 ჯაჭვი)</dd><dt>საწარმოო</dt><dd>Polygon Amoy · <span class="mono">contracts/PassportRegistry.sol</span></dd><dt>მთლიანობა</dt><dd>' + (chain.ok ? '<span class="pill ok">' + chain.length + " ბლოკი, ჯაჭვი მთელია</span>" : '<span class="pill bad">დაზიანებულია: ' + chain.bad.join(", ") + "</span>") + "</dd></dl></div>" +
      "</div>" +
      '<div class="tbl tall"><table><thead><tr><th>#</th><th>დრო</th><th>ქმედება</th><th>პასპორტი / ვერსია</th><th>PDF SHA-256</th><th>Block hash</th><th>Prev hash</th></tr></thead><tbody>' +
        blocks.map((b) => '<tr><td class="num"><b>' + b.block_index + '</b></td><td class="num small">' + fmtDT(b.created_at) + "</td><td>" + (b.action === "REGISTER_ISSUER" ? '<span class="pill violet">REGISTER_ISSUER</span>' : '<span class="pill pink">ISSUE_VERSION</span>') + '</td><td class="mono">' + esc(b.action === "REGISTER_ISSUER" ? issuer.did : b.ref) + '</td><td class="mono">' + esc(short(b.doc_sha256)) + '</td><td class="mono">' + esc(short(b.block_hash)) + '</td><td class="mono">' + esc(short(b.prev_hash)) + "</td></tr>").join("") +
      "</tbody></table></div></div>";
  }

  // ------------------------------------------------------------ start
  boot().then(go).catch((e) => {
    $("app").innerHTML = '<div class="wrap" style="padding-block:60px"><div class="notice bad">სისტემის ჩატვირთვა ვერ მოხერხდა: ' + esc(e.message) + "</div></div>";
    console.error(e);
  });
})();
