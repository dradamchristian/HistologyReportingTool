(() => {
  // === CONFIG ===
  // Base URL of your QR-pairing dictation bridge Netlify site
  const BRIDGE_SITE = "https://venerable-begonia-075ce3.netlify.app";

  // === Elements ===
  const inputEl = document.getElementById("inputText");

  const btnOpen = document.getElementById("btnPhone");
  const overlay = document.getElementById("phoneModalOverlay");
  const btnClose = document.getElementById("btnPhoneClose");

  const qrBox = document.getElementById("phoneQrBox");
  const qrHint = document.getElementById("phoneQrHint");
  const sessionLabel = document.getElementById("phoneSessionLabel");
  const phoneLinkEl = document.getElementById("phoneLink");

  const btnNew = document.getElementById("btnPhoneNew");
  const btnCopyLink = document.getElementById("btnPhoneCopyLink");
  const autoImportEl = document.getElementById("phoneAutoImport");
  const autoClearEl = document.getElementById("phoneAutoClear");

  const statusEl = document.getElementById("phoneStatus");
  const metaEl = document.getElementById("phoneMeta");

  let session = localStorage.getItem("rg_bridge_session") || "";
  let lastRev = null;
  let timer = null;

  function isValidSession(s) {
    return /^[A-Za-z0-9_-]{16,128}$/.test(s);
  }

  function makeSession() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function origin() {
    return BRIDGE_SITE.replace(/\/+$/, "");
  }

  function phoneUrl() {
    return `${origin()}/?mode=send&session=${encodeURIComponent(session)}`;
  }

  function pullUrl() {
    return `${origin()}/.netlify/functions/pull?session=${encodeURIComponent(session)}&t=${Date.now()}`;
  }

  function pushUrl() {
    return `${origin()}/.netlify/functions/push?session=${encodeURIComponent(session)}`;
  }

  async function pullLatest() {
    const res = await fetch(pullUrl(), { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function clearRemote() {
    const res = await fetch(pushUrl(), {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ text: "" })
    });
    if (!res.ok) throw new Error(await res.text());
  }

  // QR render with fallbacks
  function renderQR(url) {
    qrBox.innerHTML = "";
    qrHint.textContent = "";

    const endpoints = [
      (u) => "https://chart.googleapis.com/chart?cht=qr&chs=200x200&chld=M|0&chl=" + encodeURIComponent(u),
      (u) => "https://quickchart.io/qr?size=200&text=" + encodeURIComponent(u),
      (u) => "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(u)
    ];

    const img = document.createElement("img");
    img.alt = "QR code";
    img.width = 200;
    img.height = 200;

    let i = 0;
    function tryNext() {
      if (i >= endpoints.length) {
        qrBox.innerHTML = `<div class="small" style="padding:10px;text-align:center;">QR blocked.<br/>Use “Copy phone link”.</div>`;
        qrHint.textContent = "No QR endpoints reachable from this network.";
        return;
      }
      const src = endpoints[i++](url);
      img.src = src;
      try { qrHint.textContent = "QR source: " + new URL(src).hostname; } catch {}
    }

    img.onerror = () => tryNext();
    img.onload = () => {
      qrBox.innerHTML = "";
      qrBox.appendChild(img);
    };

    tryNext();
  }

  function ensureSession() {
    if (!isValidSession(session)) session = makeSession();
    localStorage.setItem("rg_bridge_session", session);
  }

  function flashInput() {
    if (!inputEl) return;
    const old = inputEl.style.boxShadow;
    inputEl.style.boxShadow = "0 0 0 3px rgba(52,211,153,.25)";
    setTimeout(() => { inputEl.style.boxShadow = old; }, 700);
  }

  function updateUI() {
    ensureSession();
    const link = phoneUrl();
    sessionLabel.textContent = session;
    phoneLinkEl.value = link;
    renderQR(link);
    setStatus("Scan QR (or open phone link). Then press Send on phone.");
  }

  async function importOnce({ onlyIfNew = true } = {}) {
    if (!autoImportEl.checked) return;

    try {
      const data = await pullLatest();

      if (onlyIfNew && data?.rev && data.rev === lastRev) return;
      lastRev = data?.rev || null;

      inputEl.value = data?.text || "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      flashInput();

      metaEl.textContent = data?.updated_at ? `Last update: ${data.updated_at}` : "";
      setStatus("Imported into the main Input box ✓");

      if (autoClearEl.checked) {
        await clearRemote();
        setStatus("Imported + cleared ✓");
      }

      setTimeout(() => setStatus(""), 1400);
    } catch (e) {
      // Most common cause: CORS on the bridge functions
      setStatus("Import failed. If the bridge is on a different site, it needs CORS enabled.");
      console.error(e);
    }
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(() => importOnce({ onlyIfNew: true }), 1000);
    importOnce({ onlyIfNew: true });
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function openModal() {
    updateUI();
    overlay.style.display = "flex";
    overlay.setAttribute("aria-hidden", "false");
    // Polling continues even if you close the modal (so you don't *need* to keep it open)
    startPolling();
  }

  function closeModal() {
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
    // Keep polling in background so phone sends still land in the textbox.
    // If you want it to stop when closed, swap this to stopPolling();
  }

  // Events
  btnOpen?.addEventListener("click", openModal);
  btnClose?.addEventListener("click", closeModal);

  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display === "flex") closeModal();
  });

  btnNew?.addEventListener("click", () => {
    session = makeSession();
    lastRev = null;
    localStorage.setItem("rg_bridge_session", session);
    updateUI();
    setStatus("New pairing created.");
    setTimeout(() => setStatus(""), 1200);
  });

  btnCopyLink?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(phoneLinkEl.value);
      setStatus("Phone link copied ✓ (open on iPhone)");
      setTimeout(() => setStatus(""), 1200);
    } catch {
      setStatus("Copy failed");
      setTimeout(() => setStatus(""), 1200);
    }
  });

  autoImportEl?.addEventListener("change", () => {
    if (autoImportEl.checked) startPolling();
    else stopPolling();
  });

  // Pre-generate session
  ensureSession();
})();