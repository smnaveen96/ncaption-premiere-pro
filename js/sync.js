// Copy / Paste / Sync All for clip style. Copy captures every copyable
// property of a caption (Motion, Opacity, its MOGRT's controls, font & text
// style, colors); Paste applies them to the selected captions. Sync All needs
// no Copy: it finds the caption you changed among the selected ones and
// spreads its style to the rest. Both only ever touch captions made from the
// same MOGRT as the source — the video, audio and other clips that Select
// All picks up are left alone. Self-contained, like render.js.
(function () {
  const cs = new CSInterface();
  const hasNode = typeof require === "function";
  const $ = (id) => document.getElementById(id);

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

  function host(fn, arg) {
    return new Promise((resolve) => {
      const payload = typeof arg === "string" ? arg : JSON.stringify(arg === undefined ? "" : arg);
      cs.evalScript(`${fn}(${JSON.stringify(payload)})`, resolve);
    });
  }
  const parseHost = (res) => { try { return JSON.parse(res); } catch (e) { return { ok: false, error: String(res) }; } };

  if (!hasNode) return;

  let copiedProps = null;
  let copiedTemplate = null;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const at = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  };

  function describe(p) {
    if (p.kind === "text") return "font & text style (each clip keeps its own words)";
    if (p.kind === "color") return `color (alpha ${p.value[0]}; ${p.value.slice(1).join(", ")})`;
    return JSON.stringify(p.value);
  }

  function remember(r) {
    copiedProps = r.properties;
    copiedTemplate = r.template || null;
    $("btnPasteAttrs").disabled = !(copiedProps && copiedProps.length);
  }

  function report(label, r) {
    $("attrs-status").textContent = `Applied to ${plural(r.applied, "clip", "clips")}.`;
    if (r.skipped) log(`${plural(r.skipped, "selected clip isn't a caption", "selected clips aren't captions")} made with the same MOGRT (e.g. the video or audio) — left untouched.`);
    if (r.restored) log(`${plural(r.restored, "property", "properties")} didn't read back as written on a clip, so ${r.restored === 1 ? "it was" : "they were"} put back exactly as before and skipped on the remaining clips.`, true);
    if (r.failed) log(`${plural(r.failed, "property wasn't", "properties weren't")} applied (not present on that clip, or skipped after a failed check above).`, true);
    if (r.animated) log(`${plural(r.animated, "keyframed control", "keyframed controls")} on the target clips ${r.animated === 1 ? "was" : "were"} left alone rather than flattened to a single value.`);
  }

  // Undo / Redo links show while there's a Paste / Sync All step to move through.
  async function updateUndo() {
    const st = parseHost(await host("ncUndoState"));
    $("btnUndoAttrs").style.display = st.undo > 0 ? "" : "none";
    $("btnRedoAttrs").style.display = st.redo > 0 ? "" : "none";
  }

  $("btnCopyAttrs").addEventListener("click", async () => {
    $("attrs-status").textContent = "Copying…";
    const r = parseHost(await host("ncGetClipProperties"));
    if (!r.ok) {
      $("attrs-status").textContent = "";
      return log(`Could not copy clip style: ${r.error}`, true);
    }
    remember(r);
    $("attrs-status").textContent = `Copied ${plural(copiedProps.length, "property", "properties")}.`;
    log(`Copied ${plural(copiedProps.length, "property", "properties")} from the clip at ${at(r.sourceAt)}.`);
    // Logged individually so that if a paste ever renders wrong, the log
    // shows exactly which properties were copied.
    copiedProps.forEach((p) => log(`  · ${p.component} · ${p.name} = ${describe(p)}`));
    if (r.animated) log(`${plural(r.animated, "animated (keyframed) control was", "animated (keyframed) controls were")} not copied — Premiere's scripting API can't read keyframe easing, so a copy wouldn't match.`);
  });

  $("btnPasteAttrs").addEventListener("click", async () => {
    if (!copiedProps) return;
    $("attrs-status").textContent = "Applying…";
    try {
      const r = parseHost(await host("ncApplyClipProperties", { props: copiedProps, template: copiedTemplate }));
      if (!r.ok) {
        $("attrs-status").textContent = "";
        return log(`Paste failed: ${r.error}`, true);
      }
      log(`Paste: applied ${plural(copiedProps.length, "property", "properties")} to ${plural(r.applied, "clip", "clips")}.`);
      report("Paste", r);
    } finally {
      updateUndo();
    }
  });

  $("btnSyncAllAttrs").addEventListener("click", async () => {
    $("attrs-status").textContent = "Syncing…";
    $("btnSyncAllAttrs").disabled = true;
    try {
      const r = parseHost(await host("ncSyncSelection"));
      if (!r.ok) {
        $("attrs-status").textContent = "";
        return log(`Sync All: ${r.error}`, true);
      }
      if (r.same) {
        $("attrs-status").textContent = "Already in sync.";
        return log("Sync All: the selected captions already all have the same style — nothing to change.");
      }
      remember(r); // so Paste afterwards uses this same style
      const why = r.reason === "playhead" ? "the one under the playhead" : "the one whose style differs from the rest";
      log(`Sync All: copied the style of the caption at ${at(r.sourceAt)} (${why}) to ${plural(r.applied, "other caption", "other captions")}.`);
      report("Sync All", r);
    } finally {
      $("btnSyncAllAttrs").disabled = false;
      updateUndo();
    }
  });

  // Premiere's Cmd+Z can't take back a Paste / Sync All as one step (see
  // ncStepHistory in host.jsx). These step through them one at a time, and
  // leave anything changed since — by hand or with Cmd+Z — exactly as it is.
  function historyButton(id, fn, verb, done, past) {
    $(id).addEventListener("click", async () => {
      $("btnUndoAttrs").disabled = $("btnRedoAttrs").disabled = true;
      $("attrs-status").textContent = `${verb}…`;
      try {
        const r = parseHost(await host(fn));
        if (!r.ok) {
          $("attrs-status").textContent = "";
          return log(`${done}: ${r.error}`, true);
        }
        const left = fn === "ncUndo" ? r.undo : r.redo;
        $("attrs-status").textContent = `${past}.` + (left ? ` ${left} more ${left === 1 ? "step" : "steps"} available.` : "");
        log(r.reverted ? `${done}: changed ${plural(r.reverted, "value", "values")} back.` : `${done}: nothing to change.`);
        if (r.kept) log(`${plural(r.kept, "value was", "values were")} changed again since (by hand or with Cmd+Z) — left as ${r.kept === 1 ? "it is" : "they are"}.`);
        if (r.gone) log(`${plural(r.gone, "value was", "values were")} on captions deleted since — skipped.`);
      } finally {
        $("btnUndoAttrs").disabled = $("btnRedoAttrs").disabled = false;
        updateUndo();
      }
    });
  }
  historyButton("btnUndoAttrs", "ncUndo", "Undoing", "Undo", "Undone");
  historyButton("btnRedoAttrs", "ncRedo", "Redoing", "Redo", "Redone");

  $("btnPasteAttrs").disabled = true;
  updateUndo(); // the steps live in Premiere, so they survive reopening the panel
})();
