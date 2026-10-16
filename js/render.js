// "Render & Compress" tab: render the active sequence directly inside
// Premiere (sequence.exportAsMediaDirect — Premiere's own encoder, no
// Adobe Media Encoder process), then shrink the result with ffmpeg to the
// chosen format/quality. Self-contained so a bug here can never touch the
// captioning tab's working state.
(function () {
  const NC = window.NC;
  const cs = new CSInterface();
  const hasNode = typeof require === "function";
  const fs = hasNode ? require("fs") : null;
  const path = hasNode ? require("path") : null;
  const os = hasNode ? require("os") : null;

  // Declared up front: referenced by refreshRenderBtn(), which setRenderFolder()
  // calls during initial setup below — a TDZ error if declared any later.
  let renderBusy = false;

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem("ncaption." + k); return v === null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem("ncaption." + k, v); } catch (e) {} },
  };

  function log(msg, isError) {
    const b = $("plugin-body");
    if (!b) return;
    const line = document.createElement("span");
    if (isError) line.className = "err";
    line.textContent = String(msg);
    b.appendChild(line);
    b.appendChild(document.createElement("br"));
    b.scrollTop = b.scrollHeight;
  }
  const setBar = (id, pct) => { const el = $(id); if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`; };

  function host(fn, arg) {
    return new Promise((resolve) => {
      const payload = typeof arg === "string" ? arg : JSON.stringify(arg === undefined ? "" : arg);
      cs.evalScript(`${fn}(${JSON.stringify(payload)})`, resolve);
    });
  }
  const parseHost = (res) => { try { return JSON.parse(res); } catch (e) { return { ok: false, error: String(res) }; } };

  // ---------- Tabs ----------
  function showTab(name) {
    $("tab-captions").style.display = name === "captions" ? "" : "none";
    $("tab-render").style.display = name === "render" ? "" : "none";
    $("tab-btn-captions").classList.toggle("active", name === "captions");
    $("tab-btn-render").classList.toggle("active", name === "render");
    store.set("tab", name);
  }
  $("tab-btn-captions").addEventListener("click", () => showTab("captions"));
  $("tab-btn-render").addEventListener("click", () => showTab("render"));
  showTab(store.get("tab", "captions"));

  if (!hasNode) return; // Render & Compress needs Node for ffmpeg + file paths; captions tab still works.

  // ---------- Locate Adobe's own bundled export presets ----------
  // Premiere ships these itself (no Adobe Media Encoder install required),
  // inside its own .app bundle. Presets are grouped into subfolders by
  // *container* type — the folder name is a hex-encoded pair of FourCCs
  // (verified against each .epr's own <ExporterFileType>): "4D6F6F56" is
  // "MooV" (QuickTime/.mov), "48323634" is "H264" (the MPEG-4/.mp4 group).
  // Picking the H.264 preset from the .mov group (an earlier mistake here)
  // silently renders a .mov file even though MP4 was selected — so these
  // two are intentionally kept as separate, explicit groups, not merged.
  const PRESET_GROUPS = {
    mp4: { dir: "4E49434B_48323634", names: ["01 - Match Source - High bitrate", "00 - Match Source - High bitrate"], ext: "mp4" },
    mov: { dir: "3F3F3F3F_4D6F6F56", names: ["Apple ProRes 4444 with alpha"], ext: "mov" },
  };
  function systemPresetsBase() {
    const hostApp = cs.getSystemPath(SystemPath.HOST_APPLICATION); // .../Contents/MacOS/<exe> on mac, .../<exe> on Windows
    const contents = process.platform === "darwin"
      ? path.dirname(path.dirname(hostApp)) // .../Contents/MacOS/<exe> -> .../Contents
      : path.dirname(hostApp); // Windows: install root is the exe's own folder
    return path.join(contents, "MediaIO", "systempresets");
  }
  function presetFor(format) {
    const group = PRESET_GROUPS[format] || PRESET_GROUPS.mp4;
    const base = systemPresetsBase();
    for (const n of group.names) {
      const p = path.join(base, group.dir, n + ".epr");
      if (fs.existsSync(p)) return p;
    }
    // Fallback: the subfolder name above is believed stable, but if a
    // future Premiere version groups things differently, search every
    // subfolder for a matching filename instead of just failing outright.
    try {
      for (const sub of fs.readdirSync(base)) {
        for (const n of group.names) {
          const p = path.join(base, sub, n + ".epr");
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) {}
    return null;
  }

  // ---------- Output folder ----------
  function renderFolder() { return store.get("render-folder", ""); }
  function setRenderFolder(p) {
    store.set("render-folder", p);
    $("render-folder-name").textContent = p || "Choose an output folder…";
    $("render-folder-field").classList.toggle("set", !!p);
    refreshRenderBtn();
  }
  setRenderFolder(renderFolder());
  $("btnRenderFolder").addEventListener("click", () => {
    const r = window.cep.fs.showOpenDialogEx(false, true, "Choose output folder", renderFolder() || "", []);
    if (r.err || !r.data || !r.data.length) return;
    setRenderFolder(r.data[0]);
  });

  function refreshRenderBtn() {
    $("btnRender").disabled = renderBusy || !renderFolder();
  }
  $("render-format").value = store.get("render-format", "mp4");
  $("render-format").addEventListener("change", (e) => store.set("render-format", e.target.value));
  document.querySelectorAll("input[name=render-tier]").forEach((r) => {
    r.checked = r.value === store.get("render-tier", "normal");
    r.addEventListener("change", () => store.set("render-tier", r.value));
  });
  document.querySelectorAll("input[name=render-range]").forEach((r) => {
    r.checked = r.value === store.get("render-range-type", "entire");
    r.addEventListener("change", () => store.set("render-range-type", r.value));
  });

  // ---------- Orchestration ----------
  const safeName = (s) => String(s || "sequence").replace(/[\\/:*?"<>|]+/g, "_").trim() || "sequence";
  let compressJob = null;

  function setRenderBusy(b) {
    renderBusy = b;
    $("btnCancelRender").style.display = b ? "" : "none";
    refreshRenderBtn();
  }

  // Short two-tone success chime, synthesized so no audio asset is needed.
  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      [660, 880].forEach((freq, i) => {
        const t = now + i * 0.12;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.32);
      });
      setTimeout(() => { try { ctx.close(); } catch (e) {} }, 700);
    } catch (e) {}
  }

  // Reveals the rendered file in Finder (mac) / Explorer (Windows).
  function revealInFolder(filePath) {
    try {
      const { spawn } = require("child_process");
      if (process.platform === "darwin") spawn("open", ["-R", filePath]);
      else if (process.platform === "win32") spawn("explorer", [`/select,${filePath}`]);
      else spawn("xdg-open", [path.dirname(filePath)]);
    } catch (e) { log(`Could not open the file manager: ${e.message}`, true); }
  }
  let lastOutputPath = null;
  $("btnShowInFolder").addEventListener("click", () => { if (lastOutputPath) revealInFolder(lastOutputPath); });

  async function renderAndCompress() {
    if (renderBusy) return;
    const tools = NC.tx.tools();
    if (!tools.ffmpeg) return log("FFmpeg is missing — it's required for the compression step. Install it or add it to the panel's PATH, then restart Premiere.", true);
    const folder = renderFolder();
    if (!folder) return log("Choose an output folder first.", true);
    const format = $("render-format").value;
    const tier = document.querySelector("input[name=render-tier]:checked").value;
    const range = document.querySelector("input[name=render-range]:checked").value;
    const group = PRESET_GROUPS[format] || PRESET_GROUPS.mp4;

    const preset = presetFor(format);
    if (!preset) return log(`Could not find Premiere's built-in "${group.names[0]}" export preset. Your Premiere install may be laid out differently than expected.`, true);

    setRenderBusy(true);
    setBar("render-fill", 0);
    $("btnShowInFolder").style.display = "none";
    lastOutputPath = null;
    $("render-status").textContent = "Rendering… this can take a while (Premiere renders this step directly, so it won't respond to other clicks until it's done).";
    let masterPath = null;
    try {
      const info = parseHost(await host("ncGetSequenceInfo"));
      if (!info.ok) throw new Error(info.error);

      masterPath = path.join(os.tmpdir(), `ncaption_render_${process.pid}.${group.ext}`);
      log(`Rendering "${info.name}"…`);
      const r = parseHost(await host("ncExportSequence", { presetPath: preset, outputPath: masterPath, range }));
      if (!r.ok) throw new Error(r.error);
      if (!fs.existsSync(masterPath)) throw new Error("Premiere reported success but the rendered file is missing.");

      log("Render complete. Compressing…");
      $("render-status").textContent = "Compressing… 0%";
      setBar("render-fill", 50);

      const duration = await NC.tx.probeDuration(tools.ffprobe, masterPath);
      const outBase = path.join(folder, `${safeName(info.name)}_${tier}`);
      compressJob = NC.compress.compress(tools.ffmpeg, masterPath, outBase, format, tier, duration, (pct) => {
        $("render-status").textContent = `Compressing… ${Math.round(pct)}%`;
        setBar("render-fill", 50 + pct * 0.5);
      });
      const finalPath = await compressJob.promise;
      setBar("render-fill", 100);
      // Plain text here was rendering in the same muted gray as every other
      // status line, so the checkmark was easy to miss — give it the same
      // green used for "Installed" elsewhere in the panel.
      $("render-status").innerHTML = '<span class="ok">✓ Done.</span>';
      log(`Saved: ${finalPath}`);
      lastOutputPath = finalPath;
      $("btnShowInFolder").style.display = "";
      playChime();
    } catch (e) {
      $("render-status").textContent = "";
      setBar("render-fill", 0);
      log(e.message === "Cancelled" ? "Render & Compress cancelled" : `Render & Compress failed: ${e.message}`, e.message !== "Cancelled");
    } finally {
      if (masterPath) { try { fs.unlinkSync(masterPath); } catch (e) {} }
      compressJob = null;
      setRenderBusy(false);
    }
  }
  $("btnRender").addEventListener("click", renderAndCompress);
  $("btnCancelRender").addEventListener("click", () => {
    if (compressJob) { compressJob.cancel(); return; }
    // The render step is a single blocking call into Premiere itself, so
    // there's nothing on our side to cancel until it returns.
    log("The render step can't be cancelled once started — it's a direct, blocking call into Premiere. Wait for it to finish; the compression step after it can be cancelled.", true);
  });

  refreshRenderBtn();
})();
