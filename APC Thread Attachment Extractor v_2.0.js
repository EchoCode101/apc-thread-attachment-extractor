// ==UserScript==
// @name         APC Thread Attachment Extractor
// @namespace    HamzaScripts
// @version      2.0
// @description  Extract all image and archive attachment links from entire APC thread. Includes settings, progress bar, pause/resume, per-package subfolders.
// @author       Hamza
// @match        https://forum.allporncomix.com/threads/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";

  //==================================================================
  // DEFAULT SETTINGS
  //==================================================================

  const DEFAULTS = {
    downloadFolder: "E:\\Downloads\\APC",
    chunks: 1,
    priority: "DEFAULT",
    autoStart: false,
    autoConfirm: false,
    deepAnalyseEnabled: true,
    overwritePackagizerEnabled: false,
    setBeforePackagizerEnabled: false,
    createSubfolderPerPackage: true,
    delayMin: 200,
    delayMax: 650,
    maxRetries: 3,
    retryDelay: 2000,
    exportTxt: true,
    exportCrawljob: true,
    copyToClipboard: true,
    deduplicateLinks: true,
    mergePackages: true,
    downloadImages: true,
    downloadArchives: true,
  };

  const SETTINGS_KEY = "apc_settings";
  const RESUME_KEY = "apc_resume_state";

  //==================================================================
  // SETTINGS MANAGER
  //==================================================================

  class SettingsManager {
    constructor() {
      this.data = this._load();
    }

    _load() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          return { ...DEFAULTS, ...parsed };
        }
      } catch (_) { /* ignore */ }
      return { ...DEFAULTS };
    }

    save() {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.data));
      } catch (_) { /* ignore */ }
    }

    get(key) {
      const val = this.data[key];
      return val !== undefined ? val : DEFAULTS[key];
    }

    set(key, value) {
      this.data[key] = value;
    }

    reset() {
      this.data = { ...DEFAULTS };
      this.save();
    }

    getAll() {
      return { ...this.data };
    }
  }

  //==================================================================
  // GLOBALS
  //==================================================================

  const settings = new SettingsManager();

  let abortController = null;
  let paused = false;
  let resumeResolver = null;
  let extractionStartTime = 0;
  let extractionStats = { pages: 0, packages: 0, images: 0, archives: 0, duplicates: 0, errors: 0 };

  //==================================================================
  // HELPERS
  //==================================================================

  function log(msg) {
    console.log("[APC]", msg);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = msg;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchHtml(url, signal) {
    const res = await fetch(url, { credentials: "include", signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }

  function sanitizePath(name) {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  function getThreadSlug() {
    const match = location.pathname.match(/\/threads\/([^/.]+)\.\d+/i);
    const slug = match ? match[1] : "apc_thread";
    return slug.replace(/[<>:"/\\|?*]/g, "_");
  }

  function getThreadUrl() {
    return location.protocol + "//" + location.host + location.pathname.replace(/\/page-\d+\/?$/, "").replace(/\/$/, "");
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  function formatNumber(n) {
    return n.toLocaleString();
  }

  //==================================================================
  // POST ID EXTRACTION
  //==================================================================

  function extractPostId(article) {
    let pid = null;
    try { const lb = article.closest("[data-lb-id]"); if (lb) { const m = lb.getAttribute("data-lb-id").match(/post-(\d+)/); if (m) return m[1]; } } catch (_) { /* try next format */ }
    try { pid = article.getAttribute("data-content"); if (pid) { const m = pid.match(/post-(\d+)/); if (m) return m[1]; } } catch (_) { /* try next format */ }
    try { if (article.id) { const m = article.id.match(/js-post-(\d+)/); if (m) return m[1]; } } catch (_) { /* try next format */ }
    try { const captionLink = article.querySelector('[data-caption] a[href*="#post-"]'); if (captionLink) { const m = captionLink.href.match(/#post-(\d+)/); if (m) return m[1]; } } catch (_) { /* try next format */ }
    try { const anchor = article.querySelector("a[href*='/post-']"); if (anchor) { const m = anchor.href.match(/\/post-(\d+)/); if (m) return m[1]; } } catch (_) { /* try next format */ }
    return null;
  }

  function buildPostUrl(postId) {
    const threadUrl = getThreadUrl();
    return postId ? `${threadUrl}/post-${postId}` : threadUrl;
  }

  //==================================================================
  // PACKAGE NAMING
  //==================================================================

  function extractPackageName(cleanWrapper, article, postIndex) {
    const postId = extractPostId(article);
    const pidSuffix = postId ? ` [#${postId}]` : ` [Page #${postIndex.page || "?"}, Msg #${postIndex.msg || "?"}]`;

    // Patterns to skip — short chapter/part indicators, system messages
    const skipPatterns = [
      /^(part|vol|volume|ch|chapter|ep|episode)\s*\.?\s*\d+/i,
      /^(bonus|extra|final|complete)$/i,
      /^please use download button/i,
      /^you must (click|be)/i,
      /^(click|download|view)/i,
      /^\d+\s*(mb|kb|gb)/i,
      /^attach/i,
    ];

    function isMeaningful(t) {
      if (t.length < 2) return false;
      for (const p of skipPatterns) { if (p.test(t)) return false; }
      return true;
    }

    // Priority 1: Text nodes or elements BEFORE the first <b> or <strong>
    const firstBold = cleanWrapper.querySelector("b, strong");
    if (firstBold) {
      let before = "";
      for (const node of cleanWrapper.childNodes) {
        if (node === firstBold || node.contains(firstBold)) break;
        if (node.nodeType === Node.TEXT_NODE) {
          before += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE && !["BR", "A", "IMG"].includes(node.tagName)) {
          before += node.textContent;
        }
      }
      const t = before.trim().replace(/\s+/g, " ");
      if (isMeaningful(t)) return t + pidSuffix;
    }

    // Priority 2: First <b> or <strong>, but only if meaningful (not PART 1, etc.)
    const boldEl = cleanWrapper.querySelector("b, strong");
    if (boldEl) {
      const text = boldEl.textContent.trim();
      if (isMeaningful(text)) return text + pidSuffix;
    }

    // Priority 3: First meaningful text node direct child of bbWrapper
    for (const node of cleanWrapper.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (isMeaningful(t)) return t.split("\n")[0].trim() + pidSuffix;
      }
      if (node.nodeType === Node.ELEMENT_NODE && !["BR", "A", "IMG", "SCRIPT", "STYLE"].includes(node.tagName)) {
        const t = node.textContent.trim();
        if (isMeaningful(t)) return t.split("\n")[0].trim() + pidSuffix;
      }
    }

    // Priority 4: First non-empty line of cleaned innerText
    const lines = cleanWrapper.innerText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      let title = lines[0];
      title = title.replace(/^\[[^\]]+\]\s*/, "").trim();
      if (isMeaningful(title)) return title + pidSuffix;
    }

    // Priority 5: Any heading
    const heading = cleanWrapper.querySelector("h1, h2, h3, h4");
    if (heading) {
      const t = heading.textContent.trim();
      if (isMeaningful(t)) return t + pidSuffix;
    }

    // Priority 6: Fallback — use first <b> or any text even if it matches skip patterns
    const fbBold = cleanWrapper.querySelector("b, strong");
    if (fbBold) { const t = fbBold.textContent.trim(); if (t.length > 1) return t + pidSuffix; }
    const fbLines = cleanWrapper.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    if (fbLines.length > 0) { const t = fbLines[0].replace(/^\[[^\]]+\]\s*/, "").trim(); if (t.length > 1) return t.substring(0, 80) + pidSuffix; }
    return `Unknown Album${pidSuffix}`;
  }

  //==================================================================
  // ATTACHMENT EXTRACTION
  //==================================================================

  function extractPackages(doc, pageNum) {
    const packages = [];

    // Use lbContainers directly — each post has one, which properly scopes
    // the article + attachment section together. This avoids iterating over
    // <article> elements inside quoted posts that incorrectly inherit the
    // parent post's attachment section.
    const containers = doc.querySelectorAll('[data-lb-id^="post-"]');

    containers.forEach((container, idx) => {
      const article = container.querySelector('article.message-body');
      if (!article) return;

      const wrapper = article.querySelector(".bbWrapper");
      if (!wrapper) return;

      const cleanWrapper = wrapper.cloneNode(true);

      // Remove quoted content, spoilers, expand links
      cleanWrapper.querySelectorAll(".bbCodeBlock--quote, .bbCodeBlock--spoiler, .bbCodeBlock-expandLink").forEach((el) => el.remove());

      // Package name from cleaned wrapper
      const packageName = extractPackageName(cleanWrapper, article, { page: pageNum, msg: idx + 1 });

      // Collect links from cleaned bbWrapper (inline images, no quoted content)
      const cleanLinks = [...cleanWrapper.querySelectorAll('a[href*="/attachments/"]')].map((a) => a.href);

      // Collect from the container's own <section class="message-attachments">
      // APC stores zip/rar/7z files here. Scoping to the container ensures each
      // post only gets its own attachment links, not those from other posts or quotes.
      const attachSection = container.querySelector('section.message-attachments');
      const attachLinks = attachSection
        ? [...attachSection.querySelectorAll('a[href*="/attachments/"]')].map((a) => a.href)
        : [];

      // Merge — only cleanLinks (inline, no quotes) + attachLinks (own section)
      // Removed allAttachLinks (from original un-cleaned wrapper) which incorrectly
      // included links from quoted content.
      const merged = new Set([...cleanLinks, ...attachLinks]);

      const links = [...merged]
        .filter((url) => /\.(\d+)\/?$/i.test(url) || /\/attachments\/(\d+)\/?$/i.test(url));

      // Remove truly plain attachment pages (no filename indicator at all)
      const filtered = links.filter((url) => {
        const stripped = url.replace(/\/+$/, "");
        const segment = stripped.split("/").pop() || "";
        if (/^\d+$/.test(segment)) return false;
        return true;
      });

      if (filtered.length === 0) return;

      // Categorize links — APC URL pattern: filename-ext.attachmentId/
      const imageLinks = filtered.filter((url) => /\b(jpg|jpeg|png|gif|webp)\.\d+/i.test(url));
      const archiveLinks = filtered.filter((url) => /\b(zip|rar|7z)\.\d+/i.test(url));
      const otherLinks = filtered.filter((url) => !/\b(jpg|jpeg|png|gif|webp|zip|rar|7z)\.\d+/i.test(url));

      packages.push({
        packageName,
        links: filtered,
        imageLinks,
        archiveLinks,
        otherLinks,
        postUrl: buildPostUrl(extractPostId(article)),
        postId: extractPostId(article) || `p${pageNum}-${idx + 1}`,
      });
    });

    return packages;
  }

  //==================================================================
  // THREAD CRAWLER
  //==================================================================

  async function crawlThread(onProgress) {
    const urlObj = new URL(location.href);
    urlObj.search = "";
    urlObj.hash = "";
    urlObj.pathname = urlObj.pathname.replace(/\/page-\d+\/?$/, "").replace(/\/$/, "");
    const baseUrl = urlObj.toString().replace(/\/$/, "");

    const firstHtml = await fetchHtml(baseUrl, abortController && abortController.signal);
    const firstDoc = new DOMParser().parseFromString(firstHtml, "text/html");
    const maxPage = getMaxPage(firstDoc);

    log(`Detected ${maxPage} pages`);
    const endPageInput = document.getElementById("endPage");
    if (endPageInput && (!endPageInput.value || parseInt(endPageInput.value, 10) === 0)) {
      endPageInput.value = maxPage;
    }

    const allPackages = [];
    let startPage = normalizePageInput(document.getElementById("startPage"), 1);
    let endPage = normalizePageInput(endPageInput, maxPage);
    startPage = Math.max(1, Math.min(startPage, maxPage));
    endPage = Math.max(1, Math.min(endPage, maxPage));
    if (startPage > endPage) { [startPage, endPage] = [endPage, startPage]; }

    const effectivePages = endPage - startPage + 1;

    // Resume state
    const resumeState = loadResumeState();
    const resumePage = resumeState ? resumeState.page : startPage;
    if (resumeState && resumeState.packages) allPackages.push(...resumeState.packages);

    let errors = 0;

    for (let page = Math.max(startPage, resumePage); page <= endPage; page++) {
      // Check cancellation
      if (abortController && abortController.signal.aborted) {
        log("Cancelled by user");
        break;
      }

      // Pause support
      while (paused) {
        log("Paused — waiting...");
        await new Promise((r) => { resumeResolver = r; });
        resumeResolver = null;
        if (abortController && abortController.signal.aborted) break;
      }
      if (abortController && abortController.signal.aborted) break;

      const url = page === 1 ? baseUrl : `${baseUrl}/page-${page}`;
      log(`Scanning page ${page - startPage + 1}/${effectivePages} (page ${page} of ${maxPage})`);

      let success = false;
      for (let attempt = 1; attempt <= settings.get("maxRetries"); attempt++) {
        try {
          if (abortController && abortController.signal.aborted) break;
          const html = await fetchHtml(url, abortController && abortController.signal);
          const doc = new DOMParser().parseFromString(html, "text/html");
          const packages = extractPackages(doc, page);
          allPackages.push(...packages);
          success = true;

          // Update stats
          updatePackageStats(allPackages);

          if (onProgress) {
            onProgress({
              currentPage: page,
              effectivePages,
              effectiveIndex: page - startPage + 1,
              packagesFound: allPackages.length,
              totalLinks: allPackages.reduce((s, p) => s + p.links.length, 0),
            });
          }
          break;
        } catch (err) {
          if (err.name === "AbortError") break;
          errors++;
          console.error(`[APC] Page ${page} attempt ${attempt} failed:`, err);
          if (attempt < settings.get("maxRetries")) {
            log(`Retrying page ${page} (${attempt}/${settings.get("maxRetries")})...`);
            await sleep(settings.get("retryDelay"));
          } else {
            log(`Page ${page} failed after ${settings.get("maxRetries")} attempts, skipping`);
          }
        }
      }

      if (!success) errors++;

      // Save resume state
      saveResumeState({ page, packages: allPackages });

      // Dynamic delay
      const delay = settings.get("delayMin") + Math.random() * (settings.get("delayMax") - settings.get("delayMin"));
      await sleep(delay);
    }

    clearResumeState();

    // Merge packages
    let finalPackages = allPackages;
    if (settings.get("mergePackages")) {
      const merged = new Map();
      for (const pkg of allPackages) {
        const key = pkg.packageName.toLowerCase();
        if (!merged.has(key)) merged.set(key, []);
        merged.get(key).push(pkg);
      }
      finalPackages = [...merged.entries()].map(([name, pkgs]) => {
        const allLinks = pkgs.flatMap((p) => p.links);
        const uniqueLinks = settings.get("deduplicateLinks") ? [...new Set(allLinks)] : allLinks;
        const first = pkgs[0];
        return {
          packageName: name,
          links: uniqueLinks,
          imageLinks: [...new Set(pkgs.flatMap((p) => p.imageLinks))],
          archiveLinks: [...new Set(pkgs.flatMap((p) => p.archiveLinks))],
          otherLinks: [...new Set(pkgs.flatMap((p) => p.otherLinks))],
          postUrl: first.postUrl,
          postId: first.postId,
        };
      });
    }

    // Count duplicates removed
    const totalRaw = allPackages.reduce((s, p) => s + p.links.length, 0);
    const totalUnique = finalPackages.reduce((s, p) => s + p.links.length, 0);
    extractionStats.duplicates = totalRaw - totalUnique;
    extractionStats.errors = errors;

    return {
      pages: endPage - startPage + 1,
      packages: finalPackages,
    };
  }

  function getMaxPage(doc) {
    let maxPage = 1;
    doc.querySelectorAll(".pageNav-page").forEach((link) => {
      const page = parseInt(link.textContent.trim(), 10);
      if (!isNaN(page)) maxPage = Math.max(maxPage, page);
    });
    return maxPage;
  }

  function normalizePageInput(el, fallback) {
    if (!el) return fallback;
    const num = parseInt(el.value, 10);
    if (isNaN(num)) return fallback;
    if (num < 1) return 1;
    return num;
  }

  function updatePackageStats(packages) {
    extractionStats.packages = packages.length;
    extractionStats.images = packages.reduce((s, p) => s + (p.imageLinks ? p.imageLinks.length : 0), 0);
    extractionStats.archives = packages.reduce((s, p) => s + (p.archiveLinks ? p.archiveLinks.length : 0), 0);
  }

  //==================================================================
  // RESUME STATE
  //==================================================================

  function saveResumeState(state) {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(state));
    } catch (_) { /* ignore */ }
  }

  function loadResumeState() {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function clearResumeState() {
    try { localStorage.removeItem(RESUME_KEY); } catch (_) { /* ignore */ }
  }

  //==================================================================
  // UI — MAIN PANEL
  //==================================================================

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "apcPanel";
    panel.style.cssText = `
      position: fixed;
      top: 8px;
      right: 8px;
      width: 310px;
      background: #181b27f5;
      color: #eaeaea;
      border: 1px solid rgb(89 66 230 / 72%);
      border-radius: 14px;
      padding: 14px;
      z-index: 999999;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto;
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
      backdrop-filter: blur(10px);
    `;

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 10px 0;">
        <h3 style="margin:0;">APC Attachment Extractor</h3>
        <div style="display:flex;gap:2px;">
          <button id="apcCollapseBtn"
            style="
              background:none;border:none;color:#aaa;cursor:pointer;
              font-size:18px;width:28px;height:28px;display:flex;
              align-items:center;justify-content:center;border-radius:6px;
              transition:0.15s;
            "
            title="Collapse panel"
          >−</button>
          <button id="apcSettingsBtn"
            style="
              background:none;border:none;color:#aaa;cursor:pointer;
              font-size:20px;width:32px;height:32px;display:flex;
              align-items:center;justify-content:center;border-radius:6px;
              transition:0.15s;
            "
            title="Crawler Job Settings"
          >⚙</button>
        </div>
      </div>

      <div id="apcPanelBody"
        style="max-height:2000px;opacity:1;overflow:hidden;transition:max-height 0.35s ease,opacity 0.25s ease;"
      >
        <div style="width:100%;padding:6px;border-radius:8px;border:1px solid rgb(76 84 111 / 50%);">
        <div style="display:flex;flex-direction:row;justify-content:space-between;align-items:center;">
          <div>
            Start:
            <input id="startPage" type="number" value="1"
              style="width:120px;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
            />
          </div>
          <div>
            End:
            <input id="endPage" type="number" value="" placeholder="Last page"
              style="width:120px;padding:6px;border-radius:8px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;justify-self:start;"
            />
          </div>
        </div>
        <div style="display:flex;flex-direction:row;justify-content:space-evenly;align-items:center;margin-top:16px;">
          <label><input type="checkbox" id="imagesOnly" /> Images Only</label>
          <label><input type="checkbox" id="archivesOnly" /> Archives Only</label>
        </div>
      </div>

      <button id="extractBtn"
        style="width:100%;padding:10px;cursor:pointer;border:0;border-radius:10px;
          background:#4f46e5;color:white;font-weight:600;transition:0.2s;margin-top:16px;margin-bottom:8px;"
      >Extract Entire Thread</button>

      <div id="progressArea" style="display:none;margin-bottom:8px;">
        <div style="background:#171a27f0;border-radius:8px;padding:8px;border:1px solid rgb(76 84 111 / 50%);">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span id="progressText">Page 0/0</span>
            <span id="etaText">ETA: --</span>
          </div>
          <div style="width:100%;height:8px;background:#2a2f45;border-radius:4px;overflow:hidden;">
            <div id="progressBar" style="width:0%;height:100%;background:#4f46e5;border-radius:4px;transition:width 0.3s;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#aaa;">
            <span id="statAlbums">Albums: 0</span>
            <span id="statImages">Images: 0</span>
            <span id="statArchives">Archives: 0</span>
            <span id="statElapsed">Elapsed: 00:00</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button id="pauseBtn"
              style="flex:1;padding:6px;cursor:pointer;border:0;border-radius:6px;
                background:#f59e0b;color:white;font-weight:600;font-size:12px;display:none;"
            >Pause</button>
            <button id="resumeBtn"
              style="flex:1;padding:6px;cursor:pointer;border:0;border-radius:6px;
                background:#10b981;color:white;font-weight:600;font-size:12px;display:none;"
            >Resume</button>
            <button id="cancelBtn"
              style="flex:1;padding:6px;cursor:pointer;border:0;border-radius:6px;
                background:#ef4444;color:white;font-weight:600;font-size:12px;display:none;"
            >Cancel</button>
          </div>
        </div>
      </div>

      <div id="status"
        style="margin-top:10px;padding:8px;background:#171a27f0;border-radius:8px;
          font-size:14px;border:1px solid rgb(76 84 111 / 50%);"
      >Status: Ready</div>

      <textarea id="output"
        style="width:100%;height:220px;margin-top:10px;font-size:11px;padding:8px;
          border-radius:8px;border:1px solid rgb(76 84 111 / 50%);
          background:#151825d4;color:#dcdcdc;resize:vertical;"
      ></textarea>
      </div>
    `;

    return panel;
  }

  //==================================================================
  // UI — SETTINGS MODAL
  //==================================================================

  function buildSettingsModal() {
    const overlay = document.createElement("div");
    overlay.id = "apcSettingsOverlay";
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(0,0,0,0.6);z-index:1000000;
      display:none;align-items:center;justify-content:center;
      backdrop-filter:blur(4px);
    `;

    const s = settings.getAll();
    const priorityOptions = ["HIGHEST", "HIGHER", "HIGH", "DEFAULT", "LOW", "LOWER", "LOWEST"];

    overlay.innerHTML = `
      <div style="
        background:#1e2235;color:#eaeaea;border-radius:16px;
        padding:24px;width:480px;max-height:90vh;overflow-y:auto;
        border:1px solid rgb(89 66 230 / 50%);box-shadow:0 20px 60px rgba(0,0,0,.6);
        font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;
      ">
        <h2 style="margin:0 0 16px 0;display:flex;justify-content:space-between;align-items:center;">
          Crawler Job Settings
          <span style="font-size:13px;color:#888;font-weight:normal;">v2.0</span>
        </h2>

        <div style="border-bottom:1px solid rgb(76 84 111 / 50%);padding-bottom:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#8b8;font-size:13px;">DOWNLOAD & PACKAGING</div>
          <div style="margin-bottom:8px;">
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Download Folder</label>
            <input id="set_downloadFolder" value="${s.downloadFolder}"
              style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
            />
          </div>
          <div style="display:flex;gap:12px;">
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Chunks (connections)</label>
              <input id="set_chunks" type="number" value="${s.chunks}" min="0" max="20"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              />
            </div>
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Priority</label>
              <select id="set_priority"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              >${priorityOptions.map((o) => `<option value="${o}"${o === s.priority ? " selected" : ""}>${o}</option>`).join("")}</select>
            </div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label style="font-size:13px;"><input type="checkbox" id="set_createSubfolderPerPackage"${s.createSubfolderPerPackage ? " checked" : ""} /> Create Subfolder per Package</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_deepAnalyseEnabled"${s.deepAnalyseEnabled ? " checked" : ""} /> Deep Analyse</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_overwritePackagizerEnabled"${s.overwritePackagizerEnabled ? " checked" : ""} /> Overwrite Packagizer</label>
          </div>
        </div>

        <div style="border-bottom:1px solid rgb(76 84 111 / 50%);padding-bottom:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#88b;font-size:13px;">AUTO BEHAVIOR</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label style="font-size:13px;"><input type="checkbox" id="set_autoStart"${s.autoStart ? " checked" : ""} /> Auto Start Download</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_autoConfirm"${s.autoConfirm ? " checked" : ""} /> Auto Confirm</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_setBeforePackagizerEnabled"${s.setBeforePackagizerEnabled ? " checked" : ""} /> Set Before Packagizer</label>
          </div>
        </div>

        <div style="border-bottom:1px solid rgb(76 84 111 / 50%);padding-bottom:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#b88;font-size:13px;">CRAWL DELAY & RETRY</div>
          <div style="display:flex;gap:12px;">
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Delay Min (ms)</label>
              <input id="set_delayMin" type="number" value="${s.delayMin}" min="0"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              />
            </div>
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Delay Max (ms)</label>
              <input id="set_delayMax" type="number" value="${s.delayMax}" min="0"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              />
            </div>
          </div>
          <div style="display:flex;gap:12px;">
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Max Retries</label>
              <input id="set_maxRetries" type="number" value="${s.maxRetries}" min="0" max="10"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              />
            </div>
            <div style="flex:1;margin-bottom:8px;">
              <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">Retry Delay (ms)</label>
              <input id="set_retryDelay" type="number" value="${s.retryDelay}" min="0"
                style="width:100%;padding:8px;border-radius:6px;border:1px solid rgb(76 84 111 / 50%);background:#151825d4;color:#eee;"
              />
            </div>
          </div>
        </div>

        <div style="border-bottom:1px solid rgb(76 84 111 / 50%);padding-bottom:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#b8b;font-size:13px;">EXPORT OPTIONS</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label style="font-size:13px;"><input type="checkbox" id="set_exportTxt"${s.exportTxt ? " checked" : ""} /> Export .txt</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_exportCrawljob"${s.exportCrawljob ? " checked" : ""} /> Export .crawljob</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_copyToClipboard"${s.copyToClipboard ? " checked" : ""} /> Copy to Clipboard</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_deduplicateLinks"${s.deduplicateLinks ? " checked" : ""} /> Deduplicate Links</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_mergePackages"${s.mergePackages ? " checked" : ""} /> Merge Packages</label>
          </div>
        </div>

        <div style="border-bottom:1px solid rgb(76 84 111 / 50%);padding-bottom:12px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;color:#abb;font-size:13px;">FILTER DEFAULTS</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label style="font-size:13px;"><input type="checkbox" id="set_downloadImages"${s.downloadImages ? " checked" : ""} /> Download Images</label>
            <label style="font-size:13px;"><input type="checkbox" id="set_downloadArchives"${s.downloadArchives ? " checked" : ""} /> Download Archives</label>
          </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button id="apcSettingsReset"
            style="padding:8px 16px;cursor:pointer;border:1px solid rgb(239 68 68 / 50%);border-radius:8px;
              background:transparent;color:#ef4444;font-weight:600;"
          >Reset Defaults</button>
          <button id="apcSettingsCancel"
            style="padding:8px 16px;cursor:pointer;border:1px solid rgb(76 84 111 / 50%);border-radius:8px;
              background:transparent;color:#aaa;font-weight:600;"
          >Cancel</button>
          <button id="apcSettingsSave"
            style="padding:8px 16px;cursor:pointer;border:0;border-radius:8px;
              background:#4f46e5;color:white;font-weight:600;"
          >Save</button>
        </div>
      </div>
    `;

    return overlay;
  }

  //==================================================================
  // UI — SETTINGS BINDING
  //==================================================================

  function bindSettingsModal(overlay) {
    const getEl = (id) => overlay.querySelector(id);

    const bindings = {
      downloadFolder: () => getEl("#set_downloadFolder").value.trim(),
      chunks: () => parseInt(getEl("#set_chunks").value, 10) || 1,
      priority: () => getEl("#set_priority").value,
      createSubfolderPerPackage: () => getEl("#set_createSubfolderPerPackage").checked,
      deepAnalyseEnabled: () => getEl("#set_deepAnalyseEnabled").checked,
      overwritePackagizerEnabled: () => getEl("#set_overwritePackagizerEnabled").checked,
      setBeforePackagizerEnabled: () => getEl("#set_setBeforePackagizerEnabled").checked,
      autoStart: () => getEl("#set_autoStart").checked,
      autoConfirm: () => getEl("#set_autoConfirm").checked,
      delayMin: () => parseInt(getEl("#set_delayMin").value, 10) || 200,
      delayMax: () => parseInt(getEl("#set_delayMax").value, 10) || 650,
      maxRetries: () => parseInt(getEl("#set_maxRetries").value, 10) || 3,
      retryDelay: () => parseInt(getEl("#set_retryDelay").value, 10) || 2000,
      exportTxt: () => getEl("#set_exportTxt").checked,
      exportCrawljob: () => getEl("#set_exportCrawljob").checked,
      copyToClipboard: () => getEl("#set_copyToClipboard").checked,
      deduplicateLinks: () => getEl("#set_deduplicateLinks").checked,
      mergePackages: () => getEl("#set_mergePackages").checked,
      downloadImages: () => getEl("#set_downloadImages").checked,
      downloadArchives: () => getEl("#set_downloadArchives").checked,
    };

    overlay.querySelector("#apcSettingsSave").addEventListener("click", () => {
      for (const [key, fn] of Object.entries(bindings)) {
        settings.set(key, fn());
      }
      settings.save();
      overlay.style.display = "none";
      log("Settings saved");
    });

    overlay.querySelector("#apcSettingsCancel").addEventListener("click", () => {
      overlay.style.display = "none";
    });

    overlay.querySelector("#apcSettingsReset").addEventListener("click", () => {
      settings.reset();
      // Re-populate form
      const s = settings.getAll();
      for (const [key, fn] of Object.entries(bindings)) {
        const elId = "#set_" + key;
        const el = overlay.querySelector(elId);
        if (!el) continue;
        if (el.type === "checkbox") el.checked = s[key];
        else if (el.type === "select-one") el.value = s[key];
        else el.value = s[key];
      }
      log("Settings reset to defaults");
    });

    // Close on overlay click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    });
  }

  //==================================================================
  // UI — PROGRESS DASHBOARD
  //==================================================================

  function showProgress(show) {
    const area = document.getElementById("progressArea");
    if (area) area.style.display = show ? "block" : "none";
  }

  function updateProgress(state) {
    const { currentPage, effectivePages, effectiveIndex } = state;

    const pct = effectivePages > 0 ? Math.round((effectiveIndex / effectivePages) * 100) : 0;
    const bar = document.getElementById("progressBar");
    const text = document.getElementById("progressText");
    const eta = document.getElementById("etaText");
    const albums = document.getElementById("statAlbums");
    const images = document.getElementById("statImages");
    const archives = document.getElementById("statArchives");
    const elapsed = document.getElementById("statElapsed");

    if (bar) bar.style.width = pct + "%";
    if (text) text.textContent = `Page ${effectiveIndex} / ${effectivePages} (actual: ${currentPage})`;

    // Elapsed
    const elapsedMs = Date.now() - extractionStartTime;
    if (elapsed) elapsed.textContent = `Elapsed: ${formatDuration(elapsedMs)}`;

    // ETA
    if (effectiveIndex > 0 && effectivePages > 0) {
      const msPerPage = elapsedMs / effectiveIndex;
      const remaining = msPerPage * (effectivePages - effectiveIndex);
      if (eta) eta.textContent = `ETA: ${formatDuration(remaining)}`;
    }

    if (albums) albums.textContent = `Albums: ${formatNumber(extractionStats.packages)}`;
    if (images) images.textContent = `Images: ${formatNumber(extractionStats.images)}`;
    if (archives) archives.textContent = `Archives: ${formatNumber(extractionStats.archives)}`;
  }

  //==================================================================
  // CRAWL JOB BUILDER
  //==================================================================

  function buildCrawlJob(pkg, threadSlug, threadUrl, filterLabel) {
    const pkgSettings = settings.getAll();
    const safePackageName = pkg.packageName;
    const safeFolderName = sanitizePath(pkg.packageName);
    const label = filterLabel ? `${filterLabel}\\` : "";

    // Workaround: per-package downloadFolder when subfolder setting is on
    const downloadFolder = pkgSettings.createSubfolderPerPackage
      ? `${pkgSettings.downloadFolder}\\${label}${safeFolderName}`
      : pkgSettings.downloadFolder;

    const today = new Date().toISOString().split("T")[0];
    const comment = `Thread: ${threadUrl} 
Post: ${pkg.postUrl || threadUrl} 

Album: ${pkg.packageName}
Date: ${today}
Images: ${pkg.links.filter((x) => /\b(jpg|jpeg|png|gif|webp)\.\d+/i.test(x)).length}
Archives: ${pkg.links.filter((x) => /\b(zip|rar|7z)\.\d+/i.test(x)).length}`;

    return {
      enabled: "TRUE",
      autoConfirm: pkgSettings.autoConfirm ? "TRUE" : "FALSE",
      autoStart: pkgSettings.autoStart ? "TRUE" : "FALSE",
      deepAnalyseEnabled: pkgSettings.deepAnalyseEnabled,
      overwritePackagizerEnabled: pkgSettings.overwritePackagizerEnabled,
      setBeforePackagizerEnabled: pkgSettings.setBeforePackagizerEnabled,
      packageName: safePackageName,
      comment: comment,
      priority: pkgSettings.priority,
      downloadFolder: downloadFolder,
      chunks: pkgSettings.chunks,
      text: pkg.links.join("\n"),
    };
  }

  function exportCrawlJob(packages, threadName, threadUrl, filterLabel) {
    const jobs = packages.map((pkg) => buildCrawlJob(pkg, threadName, threadUrl, filterLabel));
    downloadJson(`${threadName}.crawljob`, jobs);
  }

  //==================================================================
  // SUMMARY EXPORTER
  //==================================================================

  function exportSummary(result, threadName, threadUrl) {
    const elapsedMs = Date.now() - extractionStartTime;
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0] + " " + now.toTimeString().split(" ")[0];
    const packages = result.packages;

    const totalImages = packages.reduce((s, p) => s + p.links.filter((x) => /\b(jpg|jpeg|png|gif|webp)\.\d+/i.test(x)).length, 0);
    const totalArchives = packages.reduce((s, p) => s + p.links.filter((x) => /\b(zip|rar|7z)\.\d+/i.test(x)).length, 0);

    let summary = `APC Thread Extraction Summary
=============================
Thread: ${threadUrl}
Extracted: ${dateStr}
Pages Scanned: ${result.pages}
Time Elapsed: ${formatDuration(elapsedMs)}

Albums Found: ${packages.length}
Total Images: ${totalImages}
Total Archives: ${totalArchives}
Duplicate Links Removed: ${extractionStats.duplicates || 0}
Errors: ${extractionStats.errors || 0}

Package Details:
----------------
`;
    packages.forEach((pkg, i) => {
      const imgs = pkg.links.filter((x) => /\b(jpg|jpeg|png|gif|webp)\.\d+/i.test(x)).length;
      const archs = pkg.links.filter((x) => /\b(zip|rar|7z)\.\d+/i.test(x)).length;
      summary += `${i + 1}. ${pkg.packageName}
   Post: ${pkg.postUrl || threadUrl}
   Images: ${imgs} | Archives: ${archs}

`;
    });

    downloadText(`${threadName}_summary.txt`, summary);
  }

  //==================================================================
  // MAIN EXTRACTION FLOW
  //==================================================================

  async function handleExtract() {
    const btn = document.getElementById("extractBtn");
    const output = document.getElementById("output");
    const imagesOnly = document.getElementById("imagesOnly");
    const archivesOnly = document.getElementById("archivesOnly");

    if (btn.dataset.running === "1") return;

    // Check for existing resume state
    const resumeState = loadResumeState();
    if (resumeState && resumeState.packages && resumeState.packages.length > 0) {
      const resume = confirm(`Found a paused extraction with ${resumeState.packages.length} packages already collected. Continue from page ${resumeState.page}?`);
      if (!resume) {
        clearResumeState();
      }
    }

    btn.dataset.running = "1";
    abortController = new AbortController();
    paused = false;
    extractionStartTime = Date.now();
    extractionStats = { pages: 0, packages: 0, images: 0, archives: 0, duplicates: 0, errors: 0 };

    const pauseBtn = document.getElementById("pauseBtn");
    const resumeBtn = document.getElementById("resumeBtn");
    const cancelBtn = document.getElementById("cancelBtn");

    try {
      btn.disabled = true;
      btn.textContent = "Extracting...";
      output.value = "";
      log("Scanning thread...");

      showProgress(true);
      if (pauseBtn) pauseBtn.style.display = "inline-block";
      if (cancelBtn) cancelBtn.style.display = "inline-block";
      if (resumeBtn) resumeBtn.style.display = "none";

      const result = await crawlThread((state) => {
        updateProgress(state);
      });

      const packages = result.packages;

      // Separate by type — fix: empty array is truthy, check .length
      const imagePackages = packages
        .map((p) => ({ ...p, links: (p.imageLinks && p.imageLinks.length) ? p.imageLinks : p.links.filter((x) => /\b(jpg|jpeg|png|gif|webp)\.\d+/i.test(x)) }))
        .filter((p) => p.links.length);

      const archivePackages = packages
        .map((p) => ({ ...p, links: (p.archiveLinks && p.archiveLinks.length) ? p.archiveLinks : p.links.filter((x) => /\b(zip|rar|7z)\.\d+/i.test(x)) }))
        .filter((p) => p.links.length);

      let exportPackages = packages;

      if (imagesOnly && imagesOnly.checked) {
        exportPackages = imagePackages;
      } else if (archivesOnly && archivesOnly.checked) {
        exportPackages = archivePackages;
      }

      const flatText = exportPackages.flatMap((p) => p.links).join("\n");
      output.value = flatText;

      // Clipboard
      if (settings.get("copyToClipboard") && flatText) {
        try { GM_setClipboard(flatText); } catch (_) { /* ignore */ }
      }

      const threadName = getThreadSlug();
      const threadUrl = getThreadUrl();
      const filterSuffix = (imagesOnly && imagesOnly.checked) ? "_images_only" :
                           (archivesOnly && archivesOnly.checked) ? "_archives_only" : "";
      const filterLabel = (imagesOnly && imagesOnly.checked) ? "Images Only" :
                          (archivesOnly && archivesOnly.checked) ? "Archives Only" : "";

      // TXT export
      if (settings.get("exportTxt")) {
        if (imagesOnly && imagesOnly.checked) {
          downloadText(`${threadName}_images_only.txt`, imagePackages.flatMap((p) => p.links).join("\n"));
        } else if (archivesOnly && archivesOnly.checked) {
          downloadText(`${threadName}_archives_only.txt`, archivePackages.flatMap((p) => p.links).join("\n"));
        } else {
          downloadText(`${threadName}_all_attachments.txt`, exportPackages.flatMap((p) => p.links).join("\n"));
        }
      }

      // Crawljob export
      if (settings.get("exportCrawljob") && exportPackages.length > 0) {
        exportCrawlJob(exportPackages, threadName + filterSuffix, threadUrl, filterLabel);
      }

      // Summary export (always, as it's small and valuable)
      if (exportPackages.length > 0) {
        exportSummary({ ...result, packages: exportPackages }, threadName + filterSuffix, threadUrl);
      }

      const totalLinks = exportPackages.flatMap((p) => p.links).length;
      const elapsedStr = formatDuration(Date.now() - extractionStartTime);

      log(`Done ✔
Pages: ${result.pages} | Packages: ${exportPackages.length} | Total: ${totalLinks}
Elapsed: ${elapsedStr} | Errors: ${extractionStats.errors}
Copied to clipboard | Export completed`);
    } catch (err) {
      if (err.name === "AbortError") {
        log("Extraction cancelled");
      } else {
        console.error(err);
        log("ERROR: " + err.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Extract Entire Thread";
      btn.dataset.running = "0";
      abortController = null;
      paused = false;
      showProgress(false);
      if (pauseBtn) pauseBtn.style.display = "none";
      if (resumeBtn) resumeBtn.style.display = "none";
      if (cancelBtn) cancelBtn.style.display = "none";
    }
  }

  //==================================================================
  // PAUSE / RESUME / CANCEL
  //==================================================================

  function handlePause() {
    paused = true;
    const pauseBtn = document.getElementById("pauseBtn");
    const resumeBtn = document.getElementById("resumeBtn");
    if (pauseBtn) pauseBtn.style.display = "none";
    if (resumeBtn) resumeBtn.style.display = "inline-block";
    log("Paused — click Resume to continue");
  }

  function handleResume() {
    paused = false;
    const pauseBtn = document.getElementById("pauseBtn");
    const resumeBtn = document.getElementById("resumeBtn");
    if (pauseBtn) pauseBtn.style.display = "inline-block";
    if (resumeBtn) resumeBtn.style.display = "none";
    if (resumeResolver) resumeResolver();
    log("Resuming...");
  }

  function handleCancel() {
    if (abortController) {
      abortController.abort();
      paused = false;
      if (resumeResolver) resumeResolver();
    }
    clearResumeState();
  }

  //==================================================================
  // INITIALIZATION
  //==================================================================

  function init() {
    // Build and add main panel
    const panel = buildPanel();
    document.body.appendChild(panel);

    // Build and add settings modal
    let overlay = buildSettingsModal();
    document.body.appendChild(overlay);

    // Refs
    const btn = document.getElementById("extractBtn");
    const output = document.getElementById("output");
    const startPageInput = document.getElementById("startPage");
    const endPageInput = document.getElementById("endPage");
    const imagesOnly = document.getElementById("imagesOnly");
    const archivesOnly = document.getElementById("archivesOnly");
    const settingsBtn = document.getElementById("apcSettingsBtn");
    const collapseBtn = document.getElementById("apcCollapseBtn");
    const pauseBtn = document.getElementById("pauseBtn");
    const resumeBtn = document.getElementById("resumeBtn");
    const cancelBtn = document.getElementById("cancelBtn");

    // Bind settings modal
    bindSettingsModal(overlay);

    // Hover effects
    btn.onmouseenter = () => (btn.style.opacity = "0.85");
    btn.onmouseleave = () => (btn.style.opacity = "1");

    // Page inputs - digits only
    [startPageInput, endPageInput].forEach((input) => {
      if (input) {
        input.addEventListener("input", () => {
          input.value = input.value.replace(/[^\d]/g, "");
        });
      }
    });

    // Mutually exclusive checkboxes
    if (imagesOnly) {
      imagesOnly.addEventListener("change", () => {
        if (imagesOnly.checked && archivesOnly) archivesOnly.checked = false;
      });
    }
    if (archivesOnly) {
      archivesOnly.addEventListener("change", () => {
        if (archivesOnly.checked && imagesOnly) imagesOnly.checked = false;
      });
    }

    // Extract button
    btn.addEventListener("click", handleExtract);

    // Settings button — rebuild modal each time for fresh values
    if (settingsBtn) {
      settingsBtn.addEventListener("click", () => {
        const newOverlay = buildSettingsModal();
        if (overlay.parentNode) overlay.parentNode.replaceChild(newOverlay, overlay);
        bindSettingsModal(newOverlay);
        newOverlay.style.display = "flex";
        // Update closure reference
        overlay = newOverlay;
      });
    }

    // Pause / Resume / Cancel
    if (pauseBtn) pauseBtn.addEventListener("click", handlePause);
    if (resumeBtn) resumeBtn.addEventListener("click", handleResume);
    if (cancelBtn) cancelBtn.addEventListener("click", handleCancel);

    // Collapse / Expand toggle
    if (collapseBtn) {
      const panelBody = document.getElementById("apcPanelBody");
      let isCollapsed = false;
      try { isCollapsed = localStorage.getItem("apc_panel_collapsed") === "1"; } catch (_) { /* ignore */ }

      if (isCollapsed) {
        if (panelBody) { panelBody.style.maxHeight = "0"; panelBody.style.opacity = "0"; }
        collapseBtn.textContent = "+";
        collapseBtn.title = "Expand panel";
      }

      collapseBtn.addEventListener("click", () => {
        if (!panelBody) return;
        const currentlyCollapsed = panelBody.style.maxHeight === "0px" || panelBody.style.maxHeight === "0";
        if (currentlyCollapsed) {
          panelBody.style.maxHeight = "2000px";
          panelBody.style.opacity = "1";
          collapseBtn.textContent = "−";
          collapseBtn.title = "Collapse panel";
          try { localStorage.setItem("apc_panel_collapsed", "0"); } catch (_) { /* ignore */ }
        } else {
          panelBody.style.maxHeight = "0";
          panelBody.style.opacity = "0";
          collapseBtn.textContent = "+";
          collapseBtn.title = "Expand panel";
          try { localStorage.setItem("apc_panel_collapsed", "1"); } catch (_) { /* ignore */ }
        }
      });
    }

    log("APC Extractor v2.0 ready");
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
