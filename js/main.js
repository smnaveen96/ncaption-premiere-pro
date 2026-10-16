// nCaption panel: UI wiring.
(function () {
  const NC = window.NC;
  const cs = new CSInterface();
  const hasNode = typeof require === "function";
  const fs = hasNode ? require("fs") : null;
  const spawn = hasNode ? require("child_process").spawn : null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem("ncaption." + k); return v === null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem("ncaption." + k, v); } catch (e) {} },
  };
  const join = (...p) => p.join("/").replace(/\/+/g, "/");
  const baseName = (p) => p.split(/[\\/]/).pop();

  let srtCues = [];
  let captionName = ""; // default Export SRT name: the transcribed media or imported SRT
  let cues = [];

  // ---------- UI helpers ----------
  function log(msg, isError) {
    const b = $("plugin-body");
    const line = document.createElement("span");
    if (isError) line.className = "err";
    line.textContent = String(msg);
    b.appendChild(line);
    b.appendChild(document.createElement("br"));
    b.scrollTop = b.scrollHeight;
  }
  const setBar = (id, done, total) => { $(id).style.width = total ? `${(done / total) * 100}%` : "0%"; };
  const mb = (n) => (n / 1048576).toFixed(n > 1e9 ? 0 : 1);

  // Button that needs a second click to confirm (confirm() is not available in CEP panels).
  function twoStep(btn, label, action) {
    let timer = null;
    const orig = btn.textContent;
    btn.onclick = () => {
      if (timer) { clearTimeout(timer); timer = null; btn.textContent = orig; return action(); }
      btn.textContent = label;
      timer = setTimeout(() => { timer = null; btn.textContent = orig; }, 3000);
    };
  }

  function host(fn, arg) {
    return new Promise((resolve) => {
      const payload = typeof arg === "string" ? arg : JSON.stringify(arg === undefined ? "" : arg);
      cs.evalScript(`${fn}(${JSON.stringify(payload)})`, resolve);
    });
  }
  const parseHost = (res) => { try { return JSON.parse(res); } catch (e) { return { ok: false, error: String(res) }; } };

  const needNode = (what) => log(`${what} needs Node.js, which is not enabled in this panel. See the red message at the top.`, true);

  if (!hasNode) {
    const b = $("env-banner");
    b.style.display = "";
    b.innerHTML = "<b>Node.js is not enabled in this panel.</b> Transcription, model downloads and AI cleanup are off. " +
      "Make sure you replaced the <i>whole</i> ncaption-cep folder (CSXS/manifest.xml must contain --enable-nodejs), " +
      "then quit Premiere completely (Cmd+Q) and reopen it.";
  }

  // ---------- Clipboard ----------
  // Premiere doesn't hand Cmd/Ctrl+C to CEP panels, so text selected in the
  // log or transcript could be highlighted but never copied. Copy the
  // selection ourselves. Text fields are left to their own handling.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "c") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const text = String(window.getSelection() || "");
    if (!text) return;
    e.preventDefault();
    copyTextToClipboard(text).catch((err) => log(`Could not copy: ${err.message}`, true));
  });

  async function copyTextToClipboard(text) {
    if (hasNode && (process.platform === "darwin" || process.platform === "win32")) {
      await new Promise((resolve, reject) => {
        const proc = spawn(process.platform === "darwin" ? "/usr/bin/pbcopy" : "clip");
        let err = "";
        proc.stderr.on("data", (data) => { err += data.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(err || `pbcopy exited with code ${code}`)));
        proc.stdin.on("error", reject);
        proc.stdin.end(text);
      });
      return;
    }
    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      await window.navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!copied) throw new Error("Clipboard access is unavailable in this panel.");
  }

  // ---------- Tools check ----------
  function renderTools() {
    const box = $("tools");
    box.innerHTML = "";
    if (!hasNode) return {};
    const t = NC.tx.tools();

    const summary = document.createElement("div");
    summary.className = "tool-row";
    const mark = (ok, name) => {
      const s = document.createElement("span");
      s.className = ok ? "tool-ok" : "tool-missing";
      s.textContent = `${ok ? "✓" : "✗"} ${name}`;
      return s;
    };
    summary.append(mark(t.ffmpeg, "ffmpeg"), mark(t.whisper, "whisper-cli"));
    box.appendChild(summary);

    const note = (text) => { const d = document.createElement("div"); d.className = "hint"; d.textContent = text; box.appendChild(d); };

    note("Models use 8-bit quantized weights for faster transcription (Metal/GPU-accelerated on Apple Silicon), with minimal quality loss.");
    if (!t.whisper && process.platform === "darwin")
      note("Whisper's small runtime downloads automatically with a Whisper model.");
    if (!t.ffmpeg)
      note("FFmpeg is required to extract audio from timeline clips. If it is already installed, restart Premiere so the panel can find it.");
    return t;
  }

  // ---------- Models ----------
  const downloads = {}; // id -> { cancel }
  let selectedModel = store.get("model", "whisper-small-en");

  function renderModels() {
    const box = $("models");
    box.innerHTML = "";
    const selModel = NC.models && NC.models.MODELS.find((m) => m.id === selectedModel);
    $("models-summary").textContent = selModel ? `(${selModel.name})` : "";
    if (!hasNode) { box.innerHTML = `<div class="hint">Unavailable until Node.js is enabled.</div>`; return; }
    for (const m of NC.models.MODELS) {
      const installed = NC.models.isInstalled(m);
      const tools = NC.tx.tools();
      const runtimeReady = m.engine !== "whisper" || !!tools.whisper;
      const dl = downloads[m.id];
      const row = document.createElement("div");
      row.className = "model" + (m.id === selectedModel ? " sel" : "");

      const radio = document.createElement("input");
      radio.type = "radio"; radio.name = "model"; radio.checked = m.id === selectedModel;
      radio.onchange = () => { selectedModel = m.id; store.set("model", m.id); renderModels(); };

      const name = document.createElement("div");
      name.className = "name";
      name.innerHTML = `${esc(m.name)}<div class="meta">${esc(m.size)}</div>`;

      const state = document.createElement("div");
      state.className = "state";
      if (dl) {
        state.innerHTML = `<span id="mp-${m.id}">0%</span><div class="bar"><i id="mb-${m.id}"></i></div>`;
        const c = document.createElement("button");
        c.className = "download-cancel";
        c.type = "button";
        c.textContent = "×";
        c.title = `Cancel ${m.name} download`;
        c.setAttribute("aria-label", `Cancel ${m.name} download`);
        c.onclick = () => dl.cancel();
        state.appendChild(c);
      } else if (installed && runtimeReady) {
        state.innerHTML = `<span class="ok">Installed</span>`;
        const d = document.createElement("button");
        d.className = "small danger"; d.textContent = "Delete";
        twoStep(d, "Sure?", () => { NC.models.removeModel(m); log(`Deleted ${m.name}`); renderModels(); });
        state.appendChild(d);
      } else {
        const d = document.createElement("button");
        d.className = "small";
        d.textContent = installed ? "Get runtime" : "Download";
        d.onclick = () => startDownload(m);
        state.appendChild(d);
      }
      row.append(radio, name, state);
      box.appendChild(row);
    }
  }

  function startDownload(m) {
    log(`Downloading ${m.name} (${m.size})…`);
    let last = 0;
    const job = NC.models.downloadModel(m, (got, total, phase) => {
      const now = Date.now();
      if (now - last < 200) return;
      last = now;
      const p = $("mp-" + m.id), b = $("mb-" + m.id);
      if (p) p.textContent = `${phase === "Whisper runtime" ? "Engine · " : ""}${total ? `${Math.floor((got / total) * 100)}% · ${mb(got)}/${mb(total)} MiB` : `${mb(got)} MiB`}`;
      if (b) b.style.width = total ? `${(got / total) * 100}%` : "50%";
    });
    downloads[m.id] = { cancel: job.cancel };
    renderModels();
    job.promise
      .then(() => log(`${m.name} ready`))
      .catch((e) => log(e.message === "Cancelled" ? `Download cancelled: ${m.name}` : `Download failed: ${e.message}`, e.message !== "Cancelled"))
      .finally(() => { delete downloads[m.id]; renderModels(); });
  }

  // ---------- Transcribe ----------
  const ctl = { cancelled: false, proc: null };
  let busy = false;
  function setBusy(b) {
    busy = b;
    $("btnTranscribe").disabled = b;
    $("btnCancelTx").style.display = b ? "" : "none";
  }

  async function transcribe() {
    if (busy) return;
    if (!hasNode) return needNode("Transcription");
    const tools = renderTools();
    const model = NC.models.MODELS.find((m) => m.id === selectedModel);
    if (!model) return log("Pick a model.", true);
    const engineBin = tools.whisper;
    if (!tools.ffmpeg) return log("FFmpeg is missing. It is required to extract audio from timeline clips; install it or add it to the panel's PATH, then restart Premiere.", true);
    if (!engineBin) return log("The model file is installed, but its small Whisper runtime is missing. Click Get runtime beside this model to download it in the panel.", true);
    if (!NC.models.isInstalled(model)) return log(`Download ${model.name} first.`, true);

    ctl.cancelled = false;
    setBusy(true);
    setBar("tx-fill", 0, 1);
    try {
      const r = parseHost(await host("ncGetClips"));
      if (!r.ok) throw new Error(r.error);
      const clips = r.clips.sort((a, b) => a.startSec - b.startSec);
      log(`Transcribing ${clips.length} clip${clips.length > 1 ? "s" : ""} with ${model.name}`);

      const all = [];
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const tag = `Clip ${i + 1}/${clips.length}`;
        const wav = NC.tx.tmpWav(i);
        $("tx-status").textContent = `${tag}: extracting audio…`;
        await NC.tx.extractAudio(tools.ffmpeg, clip, wav, ctl);
        $("tx-status").textContent = `${tag}: transcribing…`;
        const part = await NC.tx.whisper(engineBin, NC.models.modelPath(model), wav, ctl, (pct) => {
          $("tx-status").textContent = `${tag}: transcribing… ${pct}%`;
          setBar("tx-fill", i + pct / 100, clips.length);
        });
        try { fs.unlinkSync(wav); } catch (e) {}
        for (const c of part) {
          const mapped = NC.tx.mapCueToSequence(c, clip);
          if (mapped) all.push(mapped);
        }
      }
      all.sort((a, b) => a.start - b.start);
      srtCues = all;
      const media = [...new Set(clips.map((c) => baseName(c.path)))];
      captionName = media.length === 1 ? media[0].replace(/\.[^.]+$/, "") : "";
      $("srt-name").textContent = `Transcribed (${clips.length} clip${clips.length > 1 ? "s" : ""})`;
      $("srt-field").classList.add("set");
      applyPhrases(true);
      setBar("tx-fill", 1, 1);
      $("tx-status").textContent = `Done: ${all.length} captions.`;
      log("Caption timestamps mapped to the clips' sequence positions and durations.");
      log(`Transcription done: ${all.length} captions`);
    } catch (e) {
      $("tx-status").textContent = "";
      setBar("tx-fill", 0, 1);
      log(e.message === "Cancelled" ? "Transcription cancelled" : `Transcription failed: ${e.message}`, e.message !== "Cancelled");
    } finally {
      setBusy(false);
    }
  }
  $("btnTranscribe").addEventListener("click", transcribe);
  $("btnCancelTx").addEventListener("click", () => {
    ctl.cancelled = true;
    if (ctl.proc) { try { ctl.proc.kill(); } catch (e) {} }
  });

  async function copyLog() {
    const body = $("plugin-body");
    const lines = [];
    for (let i = 0; i < body.children.length; i++) {
      if (body.children[i].tagName !== "BR") lines.push(body.children[i].textContent);
    }
    const text = body.innerText || lines.join("\n") || body.textContent || "";
    if (!text.trim()) {
      $("copy-status").textContent = "Log is empty.";
      return;
    }
    try {
      await copyTextToClipboard(text);
      $("copy-status").textContent = "Copied.";
      setTimeout(() => { $("copy-status").textContent = ""; }, 1800);
    } catch (e) {
      $("copy-status").textContent = "Copy failed.";
      log(`Could not copy log: ${e.message}`, true);
    }
  }
  $("copy-log").addEventListener("click", copyLog);

  // ---------- SRT import ----------
  function pick(ext, title) {
    const r = window.cep.fs.showOpenDialogEx(false, false, title, "", [ext]);
    if (r.err || !r.data || !r.data.length) return null;
    return r.data[0];
  }

  // newSource: a fresh transcription / SRT replaced srtCues, so earlier AI
  // edits no longer apply. A plain re-split (phrase length slider) keeps
  // them — they're written back into srtCues when applied.
  function applyPhrases(newSource) {
    if (newSource) {
      hideReview();
      $("ai-status").textContent = "";
      $("tx-search").value = "";
      $("tx-details").open = false;
    }
    cues = NC.srt.splitCues(srtCues, parseInt($("chars-input").value, 10), phraseUnit);
    $("phrase-summary").textContent = srtCues.length
      ? `${srtCues.length} captions become ${cues.length} phrases.`
      : "Transcribe or import an SRT to see the phrase count.";
    showTranscript();
    refresh();
  }

  // ---------- Transcript: the phrases as they'll be inserted (current phrase
  // length + applied AI edits), with timecodes, search and copy ----------
  // Sequence time as m:ss (h:mm:ss past an hour), for the transcript and
  // the AI review list.
  function timecode(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
  }
  let shownLines = []; // what Copy copies: the visible phrases, without timecodes
  function showTranscript() {
    $("tx-details").style.display = cues.length ? "" : "none";
    // Built only while open: a long transcript re-splits on every slider move.
    if (!$("tx-details").open) return;
    const q = $("tx-search").value.trim().toLowerCase();
    const box = $("tx-text");
    box.innerHTML = "";
    shownLines = [];
    for (const c of cues) {
      const at = q ? c.text.toLowerCase().indexOf(q) : 0;
      if (at < 0) continue;
      shownLines.push(c.text);
      const line = document.createElement("div");
      line.className = "tx-line";
      const tc = document.createElement("span");
      tc.className = "tc";
      tc.textContent = timecode(c.start);
      const text = document.createElement("span");
      if (q) {
        // Highlight every match in the line.
        const lower = c.text.toLowerCase();
        let i = 0, j;
        while ((j = lower.indexOf(q, i)) >= 0) {
          text.append(c.text.slice(i, j));
          const mark = document.createElement("mark");
          mark.textContent = c.text.slice(j, j + q.length);
          text.appendChild(mark);
          i = j + q.length;
        }
        text.append(c.text.slice(i));
      } else text.textContent = c.text;
      line.append(tc, text);
      box.appendChild(line);
    }
    if (q && !shownLines.length) box.innerHTML = '<div class="hint" style="margin:0">No matches.</div>';
    $("tx-copy-status").textContent = q ? `${shownLines.length} ${shownLines.length === 1 ? "match" : "matches"}` : "";
  }
  $("tx-details").addEventListener("toggle", showTranscript);
  $("tx-search").addEventListener("input", showTranscript);
  $("btnCopyTranscript").addEventListener("click", async () => {
    try {
      await copyTextToClipboard(shownLines.join("\n"));
      $("tx-copy-status").textContent = "Copied.";
    } catch (e) {
      $("tx-copy-status").textContent = "Copy failed.";
    }
    setTimeout(showTranscript, 1800);
  });

  function loadSrtFile(p) {
    const r = window.cep.fs.readFile(p, window.cep.encoding.UTF8);
    if (r.err) return log(`Could not read SRT (error ${r.err})`, true);
    srtCues = NC.srt.parseSrt(r.data);
    captionName = baseName(p).replace(/\.srt$/i, "");
    $("srt-name").textContent = baseName(p);
    $("srt-field").classList.add("set");
    applyPhrases(true);
    log(`Loaded ${srtCues.length} captions from ${baseName(p)}`);
  }

  $("btnSrt").addEventListener("click", () => {
    const p = pick("srt", "Choose an SRT file");
    if (!p) return;
    loadSrtFile(p);
  });

  // Drag-and-drop an .srt file from Finder/Explorer straight onto the field.
  // Chromium's default behavior for a file dropped anywhere on the page is
  // to navigate the panel to it (which, for a sandboxed file reference,
  // fails with ERR_FILE_NOT_FOUND) — so drag/drop must be prevented at the
  // window level, not just on the dropzone itself.
  ["dragover", "drop"].forEach((type) => {
    window.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
  });
  const srtDropzone = $("srt-field");
  srtDropzone.addEventListener("dragover", (e) => { e.preventDefault(); srtDropzone.classList.add("drag-over"); });
  srtDropzone.addEventListener("dragleave", () => srtDropzone.classList.remove("drag-over"));
  srtDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    srtDropzone.classList.remove("drag-over");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    const p = file && file.path;
    if (!p) return log("Could not read the dropped file's path.", true);
    if (!/\.srt$/i.test(p)) return log("Drop a .srt file.", true);
    loadSrtFile(p);
  });

  let phraseUnit = store.get("phrase-unit", "characters");
  if (phraseUnit !== "words") phraseUnit = "characters";
  document.querySelectorAll("input[name=phrase-unit]").forEach((input) => {
    input.checked = input.value === phraseUnit;
    input.parentElement.classList.toggle("active", input.checked);
  });
  $("chars-input").min = phraseUnit === "words" ? "1" : "5";
  $("chars-input").max = phraseUnit === "words" ? "20" : "60";
  $("chars-input").value = store.get("phrase-length." + phraseUnit, phraseUnit === "words" ? "5" : "20");
  function renderPhraseLength() {
    const amount = $("chars-input").value;
    $("chars-value").textContent = `${amount} ${phraseUnit === "words" ? "words" : "chars"}`;
  }
  renderPhraseLength();
  $("chars-input").addEventListener("input", (e) => {
    renderPhraseLength();
    store.set("phrase-length." + phraseUnit, e.target.value);
    applyPhrases();
  });
  document.querySelectorAll("input[name=phrase-unit]").forEach((input) => {
    input.addEventListener("change", () => {
      phraseUnit = input.value;
      document.querySelectorAll("input[name=phrase-unit]").forEach((choice) =>
        choice.parentElement.classList.toggle("active", choice.checked));
      const min = phraseUnit === "words" ? "1" : "5";
      const max = phraseUnit === "words" ? "20" : "60";
      $("chars-input").min = min;
      $("chars-input").max = max;
      $("chars-input").value = store.get("phrase-length." + phraseUnit, phraseUnit === "words" ? "5" : "20");
      store.set("phrase-unit", phraseUnit);
      renderPhraseLength();
      applyPhrases();
    });
  });

  // ---------- AI: provider + key ----------
  const DEFAULT_MODEL = { claude: "claude-haiku-5-5", openai: "gpt-4o-mini" };
  let provider = store.get("provider", "claude");
  let modelRequest = 0;
  let keyRequest = 0;
  const modelCache = { claude: null, openai: null };

  function showModels(activeProvider, models) {
    const select = $("ai-model");
    const saved = store.get("model." + activeProvider, DEFAULT_MODEL[activeProvider]);
    select.innerHTML = "";
    models.forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    });
    select.value = models.includes(saved) ? saved : models[0];
    store.set("model." + activeProvider, select.value);
    updateProviderSummary();
  }

  function updateProviderSummary() {
    const label = provider === "claude" ? "Claude" : "OpenAI";
    const model = $("ai-model").value;
    $("provider-summary").textContent = model ? `(${label} · ${model})` : `(${label})`;
  }

  function loadProviderUi() {
    document.querySelectorAll("input[name=provider]").forEach((r) => {
      r.checked = r.value === provider;
      r.parentElement.classList.toggle("active", r.checked);
    });
    updateProviderSummary();
    refreshModels();
    refreshKeyStatus();
  }
  async function refreshKeyStatus() {
    const requestId = ++keyRequest;
    const activeProvider = provider;
    if (!hasNode) { $("key-status").textContent = "Needs Node.js."; return; }
    try {
      const key = await NC.keys.get(activeProvider);
      if (requestId !== keyRequest) return;
      $("key-status").textContent = key ? `Saved: ${NC.keys.mask(key)} (in ${NC.keys.storage})` : "No key saved yet.";
      $("btnRemoveKey").style.display = key ? "" : "none";
    } catch (e) {
      if (requestId !== keyRequest) return;
      $("key-status").textContent = `Could not read API key: ${e.message}`;
      log(`Could not read ${activeProvider} API key: ${e.message}`, true);
    }
  }
  document.querySelectorAll("input[name=provider]").forEach((r) => {
    r.addEventListener("change", () => { provider = r.value; store.set("provider", provider); loadProviderUi(); });
  });
  async function refreshModels() {
    const requestId = ++modelRequest;
    const activeProvider = provider;
    const select = $("ai-model");
    let keyAvailable = false;
    select.disabled = true;
    select.setAttribute("aria-busy", "true");
    select.classList.add("loading");
    if (modelCache[activeProvider]) {
      showModels(activeProvider, modelCache[activeProvider]);
    } else {
      select.innerHTML = "";
      const option = document.createElement("option");
      option.textContent = `Loading ${activeProvider === "claude" ? "Claude" : "OpenAI"} models…`;
      select.appendChild(option);
    }
    $("model-status").textContent = `Loading ${activeProvider === "claude" ? "Claude" : "OpenAI"} models…`;
    try {
      if (!hasNode) throw new Error("Needs Node.js.");
      const key = await NC.keys.get(activeProvider);
      if (!key) {
        if (requestId === modelRequest) $("model-status").textContent = "Save an API key to load available models.";
        return;
      }
      keyAvailable = true;
      const models = await NC.ai.listModels(activeProvider, key);
      if (requestId !== modelRequest) return;
      if (!models.length) throw new Error("The provider returned no models for this key.");
      modelCache[activeProvider] = models;
      showModels(activeProvider, models);
      select.disabled = false;
      $("model-status").textContent = `${models.length} available model${models.length === 1 ? "" : "s"}.`;
    } catch (e) {
      if (requestId !== modelRequest) return;
      $("model-status").textContent = `Could not load models: ${e.message}`;
      log(`Could not load ${activeProvider} models: ${e.message}`, true);
    } finally {
      if (requestId === modelRequest) {
        select.classList.remove("loading");
        select.removeAttribute("aria-busy");
        select.disabled = !keyAvailable || !modelCache[activeProvider];
      }
    }
  }
  $("ai-model").addEventListener("change", (e) => { store.set("model." + provider, e.target.value); updateProviderSummary(); });
  $("btnRefreshModels").addEventListener("click", refreshModels);
  $("btnSaveKey").addEventListener("click", async () => {
    if (!hasNode) return needNode("Saving a key");
    const key = $("ai-key").value.trim();
    if (!key) return log("Paste an API key first.", true);
    try {
      await NC.keys.set(provider, key);
      $("ai-key").value = "";
      log(`${provider === "claude" ? "Claude" : "OpenAI"} key saved`);
      refreshModels();
    }
    catch (e) { log(`Could not save key: ${e.message}`, true); }
    refreshKeyStatus();
  });
  twoStep($("btnRemoveKey"), "Sure?", async () => {
    await NC.keys.remove(provider);
    log("Key removed");
    refreshKeyStatus();
    refreshModels();
  });

  // ---------- AI: prompt library ----------
  let prompts = hasNode ? NC.prompts.load() : [];
  let promptId = store.get("prompt", "");

  function currentPrompt() { return prompts.find((p) => p.id === promptId) || prompts[0]; }
  function renderPrompts() {
    const sel = $("prompt-select");
    sel.innerHTML = "";
    for (const p of prompts) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
    const cur = currentPrompt();
    if (cur) { promptId = cur.id; sel.value = cur.id; $("prompt-name").value = cur.name; $("prompt-text").value = cur.text; }
    store.set("prompt", promptId);
    $("prompt-summary").textContent = cur ? `(${cur.name})` : "";
  }
  function savePrompts() { try { NC.prompts.save(prompts); return true; } catch (e) { log(`Could not save prompts: ${e.message}`, true); return false; } }

  $("prompt-select").addEventListener("change", (e) => { promptId = e.target.value; renderPrompts(); });
  $("btnPromptNew").addEventListener("click", () => {
    if (!hasNode) return needNode("Prompts");
    const p = { id: "p" + Date.now(), name: "New prompt", text: "" };
    prompts.push(p); promptId = p.id; savePrompts(); renderPrompts(); $("prompt-name").focus();
  });
  $("btnPromptDup").addEventListener("click", () => {
    const c = currentPrompt(); if (!c) return;
    const p = { id: "p" + Date.now(), name: c.name + " copy", text: $("prompt-text").value };
    prompts.push(p); promptId = p.id; savePrompts(); renderPrompts();
  });
  twoStep($("btnPromptDel"), "Sure?", () => {
    if (prompts.length <= 1) return log("Keep at least one prompt.", true);
    prompts = prompts.filter((p) => p.id !== promptId); promptId = prompts[0].id; savePrompts(); renderPrompts();
  });
  $("btnPromptSave").addEventListener("click", () => {
    const c = currentPrompt(); if (!c) return;
    c.name = $("prompt-name").value.trim() || "Untitled";
    c.text = $("prompt-text").value;
    if (savePrompts()) { $("prompt-status").textContent = "Saved."; setTimeout(() => ($("prompt-status").textContent = ""), 1500); }
    renderPrompts();
  });

  // ---------- AI: run cleanup + review ----------
  const aiCtl = { cancelled: false, req: null };
  let changes = [];
  // The phrases as they were sent to the AI (changes[].i indexes these). Applying always
  // starts again from here, so the selection can be changed and re-applied
  // any number of times, and the phrase length can change in between.
  let aiBase = null;
  let aiApplied = false;

  function hideReview() {
    $("review").style.display = "none"; $("review-list").innerHTML = "";
    changes = []; aiBase = null; aiApplied = false;
  }

  function buildDiffRow(c, withCheckbox) {
    const row = document.createElement("div");
    row.className = "rv";
    let cb = null;
    if (withCheckbox) {
      cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = c.accept; cb.onchange = () => { c.accept = cb.checked; };
    }
    const n = document.createElement("span");
    n.className = "n"; n.textContent = "#" + (c.i + 1);
    if (c.at !== undefined) {
      const tc = document.createElement("span");
      tc.className = "tc"; tc.textContent = timecode(c.at);
      n.appendChild(tc);
    }
    const parts = NC.diff.words(c.old, c.new);
    const body = document.createElement("div");
    body.className = "rv-body";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "rv-preview";
    preview.innerHTML = parts.map((t) =>
      t.type === "same" ? esc(t.text) : t.type === "del" ? `<del>${esc(t.text)}</del>` : `<ins>${esc(t.text)}</ins>`).join(" ") +
      '<span class="rv-expand"> · Show full change</span>';
    const expanded = document.createElement("div");
    expanded.className = "rv-expanded";
    const oldText = parts.filter((t) => t.type !== "ins").map((t) =>
      t.type === "del" ? `<del>${esc(t.text)}</del>` : esc(t.text)).join(" ");
    const newText = parts.filter((t) => t.type !== "del").map((t) =>
      t.type === "ins" ? `<ins>${esc(t.text)}</ins>` : esc(t.text)).join(" ");
    expanded.innerHTML = `<div><strong>Before</strong><br>${oldText}</div><div><strong>After</strong><br>${newText}</div>`;
    preview.onclick = () => {
      expanded.classList.toggle("open");
      preview.querySelector(".rv-expand").textContent = expanded.classList.contains("open") ? " · Hide full change" : " · Show full change";
    };
    body.append(preview, expanded);
    if (cb) row.append(cb, n, body); else row.append(n, body);
    return row;
  }

  function renderReview() {
    const list = $("review-list");
    list.innerHTML = "";
    changes.forEach((c) => list.appendChild(buildDiffRow(c, true)));
    const kept = changes.filter((c) => c.accept).length;
    $("review-title").textContent = aiApplied
      ? `Applied changes (${kept} of ${changes.length})`
      : `Review changes (${changes.length})`;
    $("btnDiscard").style.display = aiApplied ? "none" : "";
    $("review").style.display = "";
  }

  async function runCleanup() {
    if (!hasNode) return needNode("AI cleanup");
    if (!cues.length) return log("Transcribe or import captions first.", true);
    const key = await NC.keys.get(provider);
    if (!key) return log("Save an API key first (AI cleanup → Provider & API key).", true);
    const model = $("ai-model").value;
    if (!model) return log("Enter a model name.", true);
    const prompt = $("prompt-text").value;

    aiCtl.cancelled = false;
    hideReview();
    $("btnClean").disabled = true;
    $("btnCancelAi").style.display = "";
    setBar("ai-fill", 0, 1);
    $("ai-status").textContent = "Cleaning up…";
    try {
      const lines = cues.map((c) => c.text);
      const base = { phrases: cues.map((c) => ({ text: c.text, src: c.src })) };
      const res = await NC.ai.cleanup({
        provider, key, model, prompt, lines, ctl: aiCtl,
        onProgress: (d, t) => { setBar("ai-fill", d, t); $("ai-status").textContent = `Cleaning up… ${d}/${t} lines`; },
      });
      changes = [];
      res.texts.forEach((t, i) => { if (t !== lines[i]) changes.push({ i, old: lines[i], new: t, accept: true, at: cues[i].start }); });
      $("ai-status").textContent = changes.length ? `${changes.length} lines changed.` : "No changes needed.";
      if (res.missing) log(`${res.missing} lines were not returned by the model and were left unchanged.`, true);
      if (changes.length) { aiBase = base; $("review").open = true; renderReview(); }
    } catch (e) {
      $("ai-status").textContent = "";
      setBar("ai-fill", 0, 1);
      log(e.message === "Cancelled" ? "Cleanup cancelled" : `Cleanup failed: ${e.message}`, e.message !== "Cancelled");
    } finally {
      $("btnCancelAi").style.display = "none";
      refresh();
    }
  }
  $("btnClean").addEventListener("click", runCleanup);
  $("btnCancelAi").addEventListener("click", () => { aiCtl.cancelled = true; if (aiCtl.req) { try { aiCtl.req.destroy(); } catch (e) {} } });
  $("btnAll").addEventListener("click", () => { changes.forEach((c) => (c.accept = true)); renderReview(); });
  $("btnNone").addEventListener("click", () => { changes.forEach((c) => (c.accept = false)); renderReview(); });
  $("btnDiscard").addEventListener("click", () => { hideReview(); $("ai-status").textContent = "Changes discarded."; });
  $("btnApply").addEventListener("click", () => {
    if (!aiBase) return;
    const phrases = aiBase.phrases.map((p) => ({ text: p.text, src: p.src }));
    changes.forEach((c) => { if (c.accept) phrases[c.i].text = c.new; });
    // Rebuild every source caption a change belongs to from the original
    // phrases + the ticked edits (unticked ones go back to the original), so
    // changing the phrase length afterwards re-splits the cleaned text.
    const touched = new Set(changes.map((c) => phrases[c.i].src));
    touched.forEach((s) => {
      if (!srtCues[s]) return;
      srtCues[s].text = phrases.filter((p) => p.src === s).map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    });
    applyPhrases();
    const acc = changes.filter((c) => c.accept).length;
    log(`Applied ${acc} of ${changes.length} AI edits`);
    aiApplied = true;
    $("review").open = false;
    renderReview();
    $("ai-status").textContent = "";
  });

  // ---------- MOGRT library (works without Node, via cep.fs) ----------
  const bundledDir = () => join(cs.getSystemPath(SystemPath.EXTENSION), "assets", "mogrt");
  const userMogrtDir = () => join(cs.getSystemPath(SystemPath.USER_DATA), "nCaption", "mogrts");

  let mogrtItems = [];
  function listMogrts() {
    const out = [];
    for (const [dir, removable] of [[bundledDir(), false], [userMogrtDir(), true]]) {
      const r = window.cep.fs.readdir(dir);
      if (r.err !== 0 || !r.data) continue;
      for (const f of r.data) if (/\.mogrt$/i.test(f)) out.push({ label: f.replace(/\.mogrt$/i, ""), path: join(dir, f), removable });
    }
    return out;
  }

  function renderMogrts(selectPath) {
    const sel = $("mogrt-select");
    mogrtItems = listMogrts();
    sel.innerHTML = "";
    if (!mogrtItems.length) sel.innerHTML = `<option value="">No MOGRTs found. Click Add…</option>`;
    for (const it of mogrtItems) {
      const o = document.createElement("option");
      o.value = it.path; o.textContent = it.label;
      sel.appendChild(o);
    }
    const want = selectPath || store.get("mogrt", "");
    if (want && mogrtItems.some((i) => i.path === want)) sel.value = want;
    store.set("mogrt", sel.value);
    refreshMogrtDelete();
    refresh();
  }

  function refreshMogrtDelete() {
    const item = mogrtItems.find((i) => i.path === $("mogrt-select").value);
    $("btnDeleteMogrt").style.display = item && item.removable ? "" : "none";
  }

  $("mogrt-select").addEventListener("change", (e) => { store.set("mogrt", e.target.value); refreshMogrtDelete(); refresh(); });
  $("btnAddMogrt").addEventListener("click", () => {
    const p = pick("mogrt", "Choose a MOGRT file");
    if (!p) return;
    const data = window.cep.fs.readFile(p, window.cep.encoding.Base64);
    if (data.err) return log(`Could not read MOGRT (error ${data.err})`, true);
    window.cep.fs.makedir(join(cs.getSystemPath(SystemPath.USER_DATA), "nCaption"));
    window.cep.fs.makedir(userMogrtDir());
    const dest = join(userMogrtDir(), baseName(p));
    const w = window.cep.fs.writeFile(dest, data.data, window.cep.encoding.Base64);
    if (w.err) return log(`Could not add MOGRT (error ${w.err})`, true);
    log(`Added ${baseName(p)}`);
    renderMogrts(dest);
  });
  twoStep($("btnDeleteMogrt"), "Sure?", () => {
    const item = mogrtItems.find((i) => i.path === $("mogrt-select").value);
    if (!item || !item.removable) return;
    const r = window.cep.fs.deleteFile(item.path);
    if (r.err) return log(`Could not delete MOGRT (error ${r.err})`, true);
    log(`Deleted ${baseName(item.path)}`);
    store.set("mogrt", "");
    renderMogrts();
  });

  // ---------- Track selection ----------
  let trackCount = 1;
  function renderTrackOptions() {
    const sel = $("track-select");
    const prev = sel.options.length ? sel.value : store.get("track-select", "new");
    sel.innerHTML = "";
    const newOpt = document.createElement("option");
    newOpt.value = "new";
    newOpt.textContent = "New track (on top)";
    sel.appendChild(newOpt);
    for (let i = trackCount; i >= 1; i--) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `V${i}`;
      sel.appendChild(o);
    }
    sel.value = Array.from(sel.options).some((o) => o.value === prev) ? prev : "new";
  }
  async function refreshTrackCount() {
    const r = parseHost(await host("ncGetTrackInfo"));
    if (r.ok) trackCount = r.count;
    renderTrackOptions();
  }
  $("track-select").addEventListener("change", (e) => store.set("track-select", e.target.value));
  renderTrackOptions();

  // ---------- Insert ----------
  // Cues per evalScript call to Premiere. Each separate call compiles and
  // ships a new ExtendScript string and switches focus between the panel
  // and the host app, which is itself a measurable cost (confirmed by other
  // Premiere scripters hitting the same thing with large loops) — so one
  // call for a whole normal-length caption set beats several. Still capped,
  // not unlimited, so a pathologically long video doesn't ship one giant
  // script string.
  const BATCH = 300;
  const INSERT_LOCK_IDS = ["mogrt-select", "btnAddMogrt", "btnDeleteMogrt", "track-select"];

  function refresh() {
    $("btnInsert").disabled = !(cues.length && $("mogrt-select").value);
    $("btnClean").disabled = !cues.length;
    $("btnExportSrt").disabled = !cues.length;
  }

  $("btnExportSrt").addEventListener("click", async () => {
    if (!cues.length) return;
    // Named after the transcribed video (or imported SRT); with several
    // videos, after the sequence.
    let name = captionName;
    if (!name) { const q = parseHost(await host("ncGetSequenceInfo")); if (q.ok) name = q.name; }
    name = String(name || "captions").replace(/[\/\\:*?"<>|]/g, "-").trim() || "captions";
    const r = window.cep.fs.showSaveDialogEx("Export SRT", "", ["srt"], name + ".srt");
    if (r.err || !r.data) return;
    const path = /\.srt$/i.test(r.data) ? r.data : r.data + ".srt";
    const w = window.cep.fs.writeFile(path, NC.srt.toSrt(cues), window.cep.encoding.UTF8);
    if (w.err) return log(`Could not save SRT (error ${w.err})`, true);
    log(`Exported ${cues.length} captions to ${baseName(path)}`);
  });

  function setInserting(on) {
    const overlay = $("insert-overlay");
    overlay.style.display = on ? "" : "none";
    INSERT_LOCK_IDS.forEach((id) => { $(id).disabled = on; });
  }

  async function insertCaptions() {
    const mogrt = $("mogrt-select").value;
    $("btnInsert").disabled = true;
    setInserting(true);
    try {
      let track;
      if ($("track-select").value === "new") {
        $("insert-overlay-text").textContent = "Creating a new video track…";
        const r = parseHost(await host("ncAddVideoTrack"));
        if (r.ok) {
          trackCount = r.count;
          track = r.count - 1;
          renderTrackOptions();
          $("track-select").value = "new";
          store.set("track-select", "new");
        } else {
          // Adding a track uses Premiere's undocumented QE automation layer,
          // which isn't available on every version. Don't let that block the
          // insert entirely — fall back to the current top track instead.
          log(`Could not create a new track (${r.error}). Inserting on the top existing track instead.`, true);
          track = Math.max(0, trackCount - 1);
        }
      } else {
        track = Math.max(0, (parseInt($("track-select").value, 10) || 1) - 1);
      }

      let done = 0;
      log(`Inserting ${cues.length} captions at their timeline timestamps…`);
      setBar("progress-fill", 0, cues.length);
      const until = cues.reduce((m, c) => Math.max(m, c.end), 0);
      for (let i = 0; i < cues.length; i += BATCH) {
        $("insert-overlay-text").textContent = `Creating captions… ${done}/${cues.length}`;
        const r = parseHost(await host("ncInsertBatch", { mogrt, track, first: i === 0, until, cues: cues.slice(i, i + BATCH) }));
        done += r.done || 0;
        setBar("progress-fill", done, cues.length);
        if (!r.ok) {
          log(`Caption ${done + 1} failed: ${r.error}`, true);
          if (r.params) log(`Params: ${r.params}`, true);
          break;
        }
      }
      log(`Inserted ${done} of ${cues.length} captions`);
    } finally {
      await host("ncRestorePlayhead");
      setInserting(false);
      refresh();
    }
  }
  $("btnInsert").addEventListener("click", insertCaptions);
  $("clear-btn").addEventListener("click", () => { $("plugin-body").innerHTML = ""; });

  // ---------- Init (each step isolated so one failure can't break the rest) ----------
  for (const [name, fn] of [["tools", renderTools], ["models", renderModels], ["mogrts", renderMogrts], ["prompts", renderPrompts], ["ai", loadProviderUi], ["tracks", refreshTrackCount]]) {
    try { fn(); } catch (e) { log(`Startup error in ${name}: ${e.message}`, true); }
  }
})();
