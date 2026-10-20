// ExtendScript side. Runs inside Premiere Pro.
var TICKS_PER_SECOND = 254016000000;

function ncJsonStr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "\\n") + '"';
}

// Replaces the text inside a MOGRT text-param JSON blob, keeping all styling.
// updateUI (default true): setValue's second argument forces Premiere to
// refresh its whole interface after the write. Batch callers pass false for
// every write but the last, so a run of N captions costs one refresh, not N
// — those per-write refreshes were the main source of the screen blinking.
function ncSetText(param, text, updateUI) {
  var ui = updateUI !== false;
  var cur = param.getValue();
  if (typeof cur === "string" && cur.indexOf("textEditValue") !== -1) {
    var esc = String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "\\r");
    var next = cur.replace(/"textEditValue":"(?:[^"\\]|\\.)*"/, function () { return '"textEditValue":"' + esc + '"'; });
    param.setValue(next, ui);
  } else {
    // Older MOGRTs expose the plain string.
    param.setValue(text, ui);
  }
}

function ncFindTextParam(comp) {
  var props = comp.properties, names = [], byName = null, byJson = null;
  for (var i = 0; i < props.numItems; i++) {
    var p = props[i];
    names.push(p.displayName);
    if (!byName && /^(source )?text$/i.test(p.displayName)) byName = p;
    if (!byJson) {
      try {
        var v = p.getValue();
        if (typeof v === "string" && v.indexOf("textEditValue") !== -1) byJson = p;
      } catch (e) {}
    }
  }
  return { param: byJson || byName, names: names.join(", ") };
}

function ncInsert(argJson) {
  try {
    var a = (typeof argJson === "string") ? eval("(" + argJson + ")") : argJson;
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';

    var ticks = String(Math.round(a.start * TICKS_PER_SECOND));
    var item = seq.importMGT(a.mogrt, ticks, a.track, a.track);
    if (!item) return '{"ok":false,"error":"importMGT returned nothing (check the MOGRT path and track number)"}';

    var comp = item.getMGTComponent();
    if (!comp) return '{"ok":false,"error":"Clip has no MOGRT component"}';

    var found = ncFindTextParam(comp);
    if (!found.param) {
      return '{"ok":false,"error":"No text parameter found in this MOGRT","params":' + ncJsonStr(found.names) + "}";
    }
    ncSetText(found.param, a.text);

    var t = new Time();
    t.seconds = a.end;
    item.end = t;
    return '{"ok":true}';
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// Keeps the Program Monitor still during an insert run — called once, on the
// first batch. The monitor re-renders on every change to the sequence, not
// just changes under the playhead, and re-rendering a real video frame is
// visibly flickery — so the playhead is parked past the end of everything,
// where there's only black to re-render. (Parking it next to the captions
// instead was tried: visibly worse.) until: end of the run's last caption,
// in seconds, across all batches; the sequence's own end is used too, so on
// a long video the park spot is still past the last frame, not just past the
// last caption. Best-effort: skipped entirely on any error.
function ncParkPlayhead(seq, until) {
  $.global.ncSavedPlayhead = undefined;
  try {
    var far = Number(until) || 0;
    try { var seqEnd = Number(seq.end) / TICKS_PER_SECOND; if (seqEnd > far) far = seqEnd; } catch (e) {}
    $.global.ncSavedPlayhead = seq.getPlayerPosition().ticks;
    seq.setPlayerPosition(String(Math.round((far + 60) * TICKS_PER_SECOND)));
  } catch (e) {}
}

// Called once by the panel after the whole insert run finishes — success,
// failure, or cancelled partway — so the playhead always gets put back and
// the run's state (its project item and clip references) is dropped,
// regardless of how the run ended, rather than threading a "last batch"
// flag through ncInsertBatch that an early error could skip past.
function ncEndInsertRun() {
  try {
    var seq = app.project.activeSequence;
    if (seq && $.global.ncSavedPlayhead !== undefined) {
      seq.setPlayerPosition(String($.global.ncSavedPlayhead));
    }
  } catch (e) {}
  $.global.ncSavedPlayhead = undefined;
  $.global.ncInsertRun = undefined;
  return '{"ok":true}';
}
function ncRestorePlayhead() { return ncEndInsertRun(); } // the name older panel builds call

// The words of a MOGRT text param, unescaped; null if unreadable.
function ncReadText(param) {
  try {
    var v = param.getValue();
    if (typeof v !== "string") return null;
    var m = NC_TEXT_RE.exec(v);
    return m ? ncUnescapeJson(m[1]) : v;
  } catch (e) { return null; }
}

// Whitespace-insensitive form of a caption's words, for comparing what was
// written with what reads back (ncSetText stores newlines as \r).
function ncSquash(s) {
  return String(s).replace(/\s+/g, " ").replace(/^ | $/g, "");
}

function ncFrameSeconds(seq) {
  var f = 0;
  try { f = Number(seq.timebase) / TICKS_PER_SECOND; } catch (e) {}
  return f > 0 && isFinite(f) ? f : 1 / 30;
}

// Index of the clip in `clips` that starts at startSec (within tol seconds),
// looking from index `from` on. Clips come in time order, so the scan stops
// as soon as it is past that time. -1 if there's none.
function ncClipIndexAt(clips, from, startSec, tol) {
  var best = -1, bestD = tol;
  for (var k = from; k < clips.numItems; k++) {
    var s = Number(clips[k].start.seconds);
    if (s > startSec + tol) break;
    var d = Math.abs(s - startSec);
    if (d <= bestD) { best = k; bestD = d; }
  }
  return best;
}

// Quick placement: another clip of the run's first caption, put on the track
// from its project item with track.overwriteClip() — what dragging that item
// from the Project panel onto the track does, a plain timeline edit rather
// than a template import. overwriteClip() doesn't hand back the new clip
// (per Adobe, matching start times is the only way to get it), so it's found
// on the track by its start, scanning on from the previous caption, and
// confirmed to come from the run's project item. Returns the new TrackItem,
// or null, in which case the caller imports the template instead.
function ncPlaceFromTemplate(seq, track, run, ticks, startSec) {
  try {
    track.overwriteClip(run.projItem, ticks);
    var clips = track.clips, tol = ncFrameSeconds(seq);
    var k = ncClipIndexAt(clips, run.scanFrom, startSec, tol);
    if (k < 0 && run.scanFrom > 0) k = ncClipIndexAt(clips, 0, startSec, tol);
    if (k < 0) return null;
    var item = clips[k];
    if (run.projNodeId && String(item.projectItem.nodeId) !== run.projNodeId) return null;
    run.scanFrom = k;
    return item;
  } catch (e) { return null; }
}

// A placed clip that didn't check out: removed (no ripple), and the rest of
// the run goes through importMGT.
function ncDropPlaced(item, run) {
  run.fast = false;
  try { item.remove(0, 0); } catch (e) {}
}

// Batch insert: one call handles many cues, so Premiere redraws far less.
//
// Only the first caption of a run goes through importMGT. That is the costly
// call — it reads the template file and creates a project item every time —
// and it was what made long runs slow and the screen flash per caption.
// Every caption after it is placed from that first caption's project item
// (ncPlaceFromTemplate), which is quick and leaves the Project panel alone.
// Checked before being relied on: the first placed caption has its words
// read back, and the first caption's words are re-read, to confirm the two
// clips hold separate text — if anything about a placed clip is off, it's
// removed and the run carries on with importMGT for every caption.
// The text parameter's index is found once (first clip) and reused after.
// Returns how many captions went each way (fast / slow) for the panel's log.
function ncInsertBatch(argJson) {
  var done = 0, fast = 0, slow = 0;
  function fail(err, extra) {
    return '{"ok":false,"done":' + done + ',"fast":' + fast + ',"slow":' + slow +
      ',"error":' + ncJsonStr(err) + (extra || "") + "}";
  }
  try {
    var a = (typeof argJson === "string") ? eval("(" + argJson + ")") : argJson;
    var seq = app.project.activeSequence;
    if (!seq) return fail("No active sequence");
    var run = $.global.ncInsertRun;
    if (a.first || !run) {
      run = $.global.ncInsertRun = {
        textIdx: -1, projItem: null, projNodeId: "", firstParam: null, firstText: null,
        verified: false, fast: true, scanFrom: 0
      };
      if (a.first) ncParkPlayhead(seq, a.until);
    }
    var track = seq.videoTracks[a.track];
    if (!track) return fail("Video track V" + (a.track + 1) + " doesn't exist");

    for (var i = 0; i < a.cues.length; i++) {
      var c = a.cues[i];
      var ticks = String(Math.round(c.start * TICKS_PER_SECOND));
      var item = null, placed = false;
      if (run.fast && run.projItem) {
        item = ncPlaceFromTemplate(seq, track, run, ticks, c.start);
        if (item) placed = true; else run.fast = false;
      }
      if (!item) {
        item = seq.importMGT(a.mogrt, ticks, a.track, a.track);
        if (!item) return fail("importMGT returned nothing (check the MOGRT path and track number)");
      }
      var comp = item.getMGTComponent();
      if (!comp) {
        if (placed) { ncDropPlaced(item, run); i--; continue; }
        return fail("Clip has no MOGRT component");
      }

      var param = null;
      if (run.textIdx >= 0) param = comp.properties[run.textIdx];
      if (!param) {
        var found = ncFindTextParam(comp);
        if (!found.param) {
          if (placed) { ncDropPlaced(item, run); i--; continue; }
          return fail("No text parameter found in this MOGRT", ',"params":' + ncJsonStr(found.names));
        }
        param = found.param;
        for (var k = 0; k < comp.properties.numItems; k++) {
          if (comp.properties[k].displayName === param.displayName) { run.textIdx = k; break; }
        }
      }
      ncSetText(param, c.text, i === a.cues.length - 1);

      if (placed && !run.verified) {
        // The same template instance twice: each clip must keep its own words.
        var mine = ncReadText(param);
        var theirs = run.firstText === c.text ? run.firstText : ncReadText(run.firstParam);
        if (mine === null || ncSquash(mine) !== ncSquash(c.text) || theirs !== run.firstText) {
          ncDropPlaced(item, run);
          if (theirs !== run.firstText) { try { ncSetText(run.firstParam, run.firstText, false); } catch (e) {} }
          i--; continue;
        }
        // Proven only once the two captions' words differ; identical ones
        // (two "Yeah."s) can't tell shared text from separate text.
        if (run.firstText !== c.text) run.verified = true;
      }
      if (!placed && !run.projItem) {
        try {
          run.projItem = item.projectItem;
          run.projNodeId = String(run.projItem.nodeId || "");
          run.firstParam = param;
          run.firstText = ncReadText(param);
          if (!run.projItem || run.firstText === null) run.fast = false;
        } catch (e) { run.fast = false; }
      }

      var t = new Time();
      t.seconds = c.end;
      item.end = t;
      if (placed) fast++; else slow++;
      done++;
    }
    return '{"ok":true,"done":' + done + ',"fast":' + fast + ',"slow":' + slow + "}";
  } catch (e) {
    return fail(e.toString());
  }
}

// ---- Video track helpers -------------------------------------------------
function ncGetTrackInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    return '{"ok":true,"count":' + seq.videoTracks.numTracks + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// Adds a new video track above all existing ones, via the QE DOM (the
// documented ExtendScript API has no track-insert method). Returns the new
// track count; the new track is always the highest-numbered (topmost) one.
function ncAddVideoTrack() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    var before = seq.videoTracks.numTracks;
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return '{"ok":false,"error":"Could not access Premiere\'s QE DOM to add a track. Restart Premiere and try again."}';
    qeSeq.addTracks(1, before, 0, 0, 0);
    var after = seq.videoTracks.numTracks;
    if (after <= before) return '{"ok":false,"error":"Premiere did not add a new track"}';
    return '{"ok":true,"count":' + after + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// ---- Clips for transcription -------------------------------------------
function ncAddClip(out, seen, c) {
  if (!c || !c.projectItem) return;
  var p = "";
  try { p = c.projectItem.getMediaPath(); } catch (e) {}
  if (!p) return;
  var sourceIn = c.inPoint.seconds, sourceOut = c.outPoint.seconds;
  var speed = 1, reversed = false;
  try { speed = Math.abs(c.getSpeed()); } catch (e) {}
  try { reversed = c.isSpeedReversed() === 1; } catch (e) {}
  if (!speed || !isFinite(speed)) speed = 1;
  var sourceStart = Math.min(sourceIn, sourceOut);
  var sourceDuration = Math.abs(sourceOut - sourceIn);
  var sequenceDuration = c.end.seconds - c.start.seconds;
  if (!sourceDuration) sourceDuration = (c.end.seconds - c.start.seconds) * speed;
  var key = p + "|" + c.start.seconds + "|" + sourceIn + "|" + sourceOut + "|" + speed + "|" + reversed;
  if (seen[key]) return;
  seen[key] = 1;
  out.push('{"path":' + ncJsonStr(p) + ',"sourceInSec":' + sourceStart +
    ',"sourceDurSec":' + sourceDuration + ',"speed":' + speed + ',"reversed":' + reversed +
    ',"startSec":' + c.start.seconds + ',"sequenceDurSec":' + sequenceDuration + "}");
}

// Selected clips if any; otherwise every clip on audio track 1 (then video track 1).
function ncGetClips() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    var out = [], seen = {}, i, sel = seq.getSelection();
    for (i = 0; i < sel.length; i++) ncAddClip(out, seen, sel[i]);
    if (!out.length) {
      var tr = seq.audioTracks.numTracks ? seq.audioTracks[0] : null;
      if (!tr || !tr.clips.numItems) tr = seq.videoTracks[0];
      for (i = 0; tr && i < tr.clips.numItems; i++) ncAddClip(out, seen, tr.clips[i]);
    }
    if (!out.length) return '{"ok":false,"error":"No clips with media found. Select the clip(s) to transcribe."}';
    return '{"ok":true,"clips":[' + out.join(",") + "]}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// ---- Render (export) the active sequence, directly inside Premiere ------
// Uses sequence.exportAsMediaDirect, which renders with Premiere's own
// encoder and blocks until the file is fully written — no Adobe Media
// Encoder process, no job queue, no completion-event plumbing to get
// subtly wrong. The tradeoff: no incremental progress during this step,
// and Premiere is busy until it returns.
function ncGetSequenceInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    return '{"ok":true,"name":' + ncJsonStr(seq.name) + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// a.presetPath: absolute path to a .epr preset file (Adobe-authored; we
// reference Premiere's own bundled "Match Source" presets rather than
// writing our own — those are version/build-specific and too easy to get
// subtly wrong).
// a.outputPath: absolute path, WITH extension, for the rendered file.
// a.range: "inout" to render only the sequence's current In/Out points,
// anything else (or omitted) for the entire sequence.
function ncExportSequence(argJson) {
  try {
    var a = (typeof argJson === "string") ? eval("(" + argJson + ")") : argJson;
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';

    var presetFile = new File(a.presetPath);
    if (!presetFile.exists) return '{"ok":false,"error":' + ncJsonStr("Export preset not found: " + a.presetPath) + "}";
    var outFile = new File(a.outputPath);

    var range = app.encoder.ENCODE_ENTIRE;
    if (a.range === "inout") {
      try { range = app.encoder.ENCODE_IN_TO_OUT; } catch (e) {}
      if (range === undefined || range === null) range = app.encoder.ENCODE_ENTIRE;
    }

    seq.exportAsMediaDirect(outFile.fsName, presetFile.fsName, range);
    if (!outFile.exists) return '{"ok":false,"error":"Premiere finished without producing an output file. Check that the export preset is valid for this sequence."}';
    return '{"ok":true}';
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// ---- Clip property discovery + sync (Edit & Sync tab) --------------------
// Deliberately generic: reads back whatever properties a clip's components
// (the built-in Motion effect, the MOGRT's own Essential Graphics controls,
// any other applied effect) actually expose, identified by component+property
// display name rather than a hardcoded list or index. Different MOGRTs
// expose completely different controls, and indices aren't stable across
// clips with different effect stacks — so discovering live, then matching
// by name, is the only approach that doesn't risk silently touching the
// wrong property (or nothing at all) on someone else's template.

// A GUID, or a ";"-separated chain of them. These show up as the *value* of
// a component's group-header properties (e.g. "Word Highlight Controls"),
// listing that group's own child-property IDs — fixed, template-level
// metadata, not per-clip instance data — so there's nothing meaningful to
// "sync" there; setValue on a group header isn't a real write anyway.
var NC_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(;[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*;?$/i;

// Above 2^53 a number isn't a plain control value — on the MOGRT color
// controls we've seen, it's a packed color: four 16-bit fields
// [0x0100][R][G][B], each 8-bit channel in the field's high byte. That
// packing doesn't survive getValue()/setValue(): written back, it came out
// shifted by one field (white -> RGB(1,255,255), i.e. cyan). Colors go
// through Premiere's dedicated getColorValue()/setColorValue() instead.
var NC_MAX_SAFE_INT = 9007199254740991;

// The caption words inside a MOGRT text param's JSON value.
var NC_TEXT_RE = /"textEditValue":"((?:[^"\\]|\\.)*)"/;

function ncIsPlainValue(v) {
  var t = typeof v;
  if (t === "string") return !NC_GUID_RE.test(v);
  if (t === "number") return Math.abs(v) <= NC_MAX_SAFE_INT;
  if (t === "boolean") return true;
  if (v && typeof v.length === "number") { // array-like, e.g. a point's [x, y]
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "number" || Math.abs(v[i]) > NC_MAX_SAFE_INT) return false;
    return true;
  }
  return false;
}

// What a param holds and how to copy it: {kind, value}, {skip: "animated"},
// or null (nothing to copy).
//   kind "text"  — the MOGRT text param's JSON value: the caption words plus
//                  font, size and style. Pasting applies the style only;
//                  every target keeps its own words.
//   kind "color" — [alpha, red, green, blue] from getColorValue().
//   kind "value" — anything else plain (numbers, booleans, points).
function ncDescribeParam(p) {
  // getValue()/setValue() only work on non-animated params (Adobe's docs),
  // so a keyframed control would otherwise copy a bogus value.
  try { if (p.isTimeVarying()) return { skip: "animated" }; } catch (e) {}
  var val;
  try { val = p.getValue(); } catch (e) { return null; }
  if (typeof val === "string" && NC_TEXT_RE.test(val)) return { kind: "text", value: val };
  // Plain-string text params have no style to copy, and their words must never be copied.
  if (/^(source )?text$/i.test(p.displayName || "")) return null;
  if (typeof val === "number" && Math.abs(val) > NC_MAX_SAFE_INT) {
    var c = ncReadColor(p);
    return c ? { kind: "color", value: c } : null;
  }
  return ncIsPlainValue(val) ? { kind: "value", value: val } : null;
}

// getColorValue() as [a, r, g, b] — only when every channel is a whole
// 0–255 value, the scale setColorValue() takes (per Adobe's sample code).
// Any other scale is left alone rather than risk writing it back clamped.
function ncReadColor(p) {
  var c = null;
  try { c = p.getColorValue(); } catch (e) {}
  if (!c || !(c.length >= 4)) return null;
  var out = [];
  for (var i = 0; i < 4; i++) {
    var v = Number(c[i]);
    if (!(v >= 0 && v <= 255) || Math.round(v) !== v) return null;
    out.push(v);
  }
  return out;
}

// Flat list of copyable properties on one item, plus how many animated
// (keyframed) ones were skipped.
function ncListItemProperties(item) {
  var out = [], animated = 0;
  var seen = {}; // guards against duplicate (component, name) pairs — some
  // built-in effects (e.g. "Opacity") have reported two separate
  // ComponentParam entries both displayed as "Blend Mode" with different
  // values. Our matching is keyed by component+name, so a duplicate makes
  // that key ambiguous (unclear which one "wins" on apply) — keep only the
  // first one seen rather than silently syncing a coin-flip value.
  for (var ci = 0; ci < item.components.numItems; ci++) {
    var comp = item.components[ci];
    for (var pi = 0; pi < comp.properties.numItems; pi++) {
      var p = comp.properties[pi];
      // Computed by the template itself (e.g. word timing); copying would
      // freeze another clip's values onto this one.
      if (/\(automated\)/i.test(p.displayName || "")) continue;
      var key = comp.displayName + "\u0001" + p.displayName;
      if (seen[key]) continue;
      var d = ncDescribeParam(p);
      if (!d) continue;
      seen[key] = true;
      if (d.skip) { animated++; continue; }
      out.push({ component: comp.displayName, name: p.displayName, kind: d.kind, value: d.value });
    }
  }
  return { props: out, animated: animated };
}

// Which template a clip was made from. Captions from the same MOGRT expose
// the exact same list of Essential Graphics controls; anything else — the
// video, the audio, a different caption style — gets a different key.
// Paste and Sync All only write to clips with the source's key: Select All
// also selects the source video and audio, which share Motion and Opacity
// with captions and would otherwise get a caption's position, scale and
// opacity written onto them. (Separated by "\n", not a control character,
// because the key round-trips through JSON to the panel and back.)
function ncTemplateKey(item) {
  var mgt = null;
  try { mgt = item.getMGTComponent(); } catch (e) {}
  if (!mgt) return "plain";
  var names = [];
  try { for (var i = 0; i < mgt.properties.numItems; i++) names.push(mgt.properties[i].displayName); } catch (e) {}
  return "mogrt\n" + names.join("\n");
}

function ncSelectionArray(seq) {
  var sel = seq.getSelection(), out = [];
  for (var i = 0; i < sel.length; i++) out.push(sel[i]);
  return out;
}

function ncPropsJson(props) {
  var json = [];
  for (var i = 0; i < props.length; i++) {
    var p = props[i];
    json.push('{"component":' + ncJsonStr(p.component) + ',"name":' + ncJsonStr(p.name) +
      ',"kind":' + ncJsonStr(p.kind) + ',"value":' + JSON.stringify(p.value) + "}");
  }
  return "[" + json.join(",") + "]";
}

function ncStartSeconds(item) {
  try { return Number(item.start.seconds) || 0; } catch (e) { return 0; }
}

function ncItemCovers(item, p) {
  try { return Number(item.start.seconds) <= p && p < Number(item.end.seconds); } catch (e) { return false; }
}

// Copy: the first selected caption (the first selected clip if none is a
// caption) — getSelection() is in timeline order, and with Select All the
// source video at 0:00 would otherwise come first.
function ncGetClipProperties() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    var sel = ncSelectionArray(seq);
    if (!sel.length) return '{"ok":false,"error":"Select a clip first."}';
    var src = sel[0];
    for (var i = 0; i < sel.length; i++) if (ncTemplateKey(sel[i]) !== "plain") { src = sel[i]; break; }
    var res = ncListItemProperties(src);
    return '{"ok":true,"template":' + ncJsonStr(ncTemplateKey(src)) + ',"sourceAt":' + ncStartSeconds(src) +
      ',"animated":' + res.animated + ',"properties":' + ncPropsJson(res.props) + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

function ncSame4(a, b) {
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  for (var i = 0; i < 4; i++) if (Math.abs(Number(a[i]) - Number(b[i])) > 1) return false;
  return true;
}

// Which argument order setColorValue() needs for getColorValue()'s output:
// 0 = as read ([a, r, g, b], matching setColorValue's documented
// arguments), 1 = last two swapped. Adobe's own sample code names
// getColorValue()'s last two entries the other way round from
// setColorValue's arguments, so the order isn't assumed — it's learned from
// the first write whose read-back proves it (and only once proven:
// when those two channels are equal, either order reads back the same).
var ncColorOrder = null;

// Writes color c and confirms it by reading it back. Returns the order that
// worked (0/1), or -1 if neither produced c.
function ncWriteColor(param, c, ui) {
  var orders = ncColorOrder === null ? [0, 1] : [ncColorOrder, 1 - ncColorOrder];
  for (var k = 0; k < orders.length; k++) {
    var o = orders[k];
    if (o === 0) param.setColorValue(c[0], c[1], c[2], c[3], ui ? 1 : 0);
    else param.setColorValue(c[0], c[1], c[3], c[2], ui ? 1 : 0);
    var r = null;
    try { r = param.getColorValue(); } catch (e) {}
    if (ncSame4(r, c)) {
      if (Number(c[2]) !== Number(c[3])) ncColorOrder = o;
      return o;
    }
  }
  return -1;
}

function ncUnescapeJson(raw) {
  try { return eval('"' + raw + '"'); } catch (e) { return raw; }
}

function ncSameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-4);
  if (a && b && typeof a === "object" && typeof b === "object" && a.length === b.length) {
    for (var i = 0; i < a.length; i++) if (!ncSameValue(a[i], b[i])) return false;
    return true;
  }
  return a === b;
}

// Per-axis ratio read/written, when a point read back differently from what
// was written by a constant factor per axis (e.g. one side normalized, the
// other in pixels). null when there's no consistent ratio to correct with.
function ncPointRatio(read, written) {
  if (!read || typeof read !== "object" || read.length !== written.length) return null;
  var k = [];
  for (var i = 0; i < written.length; i++) {
    var w = Number(written[i]), r = Number(read[i]);
    if (w === 0 && r === 0) k.push(1);
    else if (w === 0 || r === 0 || !isFinite(r / w)) return null;
    else k.push(r / w);
  }
  return k;
}

function ncDivide(v, k) {
  var out = [];
  for (var i = 0; i < v.length; i++) out.push(Number(v[i]) / k[i]);
  return out;
}

// Applies one copied property to one target param. On success returns
// {ok: true, refresh} — refresh describes the change (old -> new value as
// written) so it can be replayed to trigger the one screen refresh at the
// end, or null if the param already held that value. Colors, text style and
// template points are read back after writing; if the target didn't end up
// holding what was meant, it's put back to its original value
// ({ok: false, restored: true}) — so a property that doesn't copy cleanly
// can't leave a clip corrupted.
// A target that already holds the value is never written at all: fewer
// writes for Premiere to process (in a Sync All, usually only the few
// controls that were actually edited differ), and a control that's already
// right can't be disturbed.
function ncApplyOne(found, want, componentName) {
  if (want.kind === "color") {
    var orig = ncReadColor(found);
    if (!orig) return { ok: false };
    if (ncSame4(orig, want.value)) return { ok: true, refresh: null };
    var order = ncWriteColor(found, want.value, false);
    if (order >= 0) return { ok: true, refresh: { color: true, param: found, from: orig, to: want.value, order: order, seen: want.value } };
    ncWriteColor(found, orig, false);
    return { ok: false, restored: true };
  }
  if (want.kind === "text") {
    var cur = found.getValue();
    var m = typeof cur === "string" ? NC_TEXT_RE.exec(cur) : null;
    if (!m) return { ok: false };
    var words = m[1];
    var merged = want.value.replace(NC_TEXT_RE, function () { return '"textEditValue":"' + words + '"'; });
    if (merged === cur) return { ok: true, refresh: null };
    found.setValue(merged, false);
    // The words must survive untouched — that's the one thing a style paste
    // can never be allowed to change.
    var back = found.getValue();
    var mb = typeof back === "string" ? NC_TEXT_RE.exec(back) : null;
    if (mb && ncUnescapeJson(mb[1]) === ncUnescapeJson(words)) return { ok: true, refresh: { param: found, from: cur, to: merged, seen: back } };
    found.setValue(cur, false);
    return { ok: false, restored: true };
  }
  // Plain values. Scalars, and the Motion effect's points, are proven to
  // copy cleanly and are written as before; points on a template's own
  // controls (padding, offsets) are verified the same way as colors.
  var val = want.value;
  var before = found.getValue();
  if (ncSameValue(before, val)) return { ok: true, refresh: null };
  var isPoint = val && typeof val === "object";
  if (isPoint && componentName !== "Motion") {
    found.setValue(val, false);
    var read = found.getValue();
    if (ncSameValue(read, val)) return { ok: true, refresh: { param: found, from: before, to: val, seen: read } };
    // Read back differently. If it's off by a constant factor per axis
    // (getValue and setValue disagreeing on units), that factor corrects
    // both the write and, failing that, the restore.
    var k = ncPointRatio(read, val);
    if (k) {
      var corrected = ncDivide(val, k);
      found.setValue(corrected, false);
      var read2 = found.getValue();
      if (ncSameValue(read2, val)) return { ok: true, refresh: { param: found, from: ncDivide(before, k), to: corrected, seen: read2 } };
      found.setValue(ncDivide(before, k), false);
      if (ncSameValue(found.getValue(), before)) return { ok: false, restored: true };
    }
    found.setValue(before, false);
    return { ok: false, restored: true };
  }
  found.setValue(val, false);
  return { ok: true, refresh: { param: found, from: before, to: val, seen: found.getValue() } };
}

function ncSetColorOrdered(param, c, order, ui) {
  if (order === 1) param.setColorValue(c[0], c[1], c[3], c[2], ui);
  else param.setColorValue(c[0], c[1], c[2], c[3], ui);
}

// The one screen refresh after a paste/sync. Every write above skips the
// forced UI update (see ncSetText). Re-writing the last value with
// updateUI on wasn't enough: that value is already there, Premiere treats it
// as no change, and the screen stayed stale until the playhead moved. So
// one real change is replayed instead — the property is set back to what it
// was, then to the new value with updateUI on. And if a changed clip is
// what's on screen, the playhead is stepped a frame forward and back —
// moving the playhead is the one thing confirmed to make the monitor redraw.
function ncRefreshAfterApply(seq, rec, onScreen) {
  if (!rec) return;
  try {
    if (rec.color) {
      ncSetColorOrdered(rec.param, rec.from, rec.order, 0);
      ncSetColorOrdered(rec.param, rec.to, rec.order, 1);
    } else {
      rec.param.setValue(rec.from, false);
      rec.param.setValue(rec.to, true);
    }
  } catch (e) {}
  if (!onScreen) return;
  try {
    var pos = seq.getPlayerPosition();
    var frame = Number(seq.timebase) || Math.round(TICKS_PER_SECOND / 30);
    seq.setPlayerPosition(String(Number(pos.ticks) + frame));
    seq.setPlayerPosition(String(pos.ticks));
  } catch (e) {}
}

function ncFindParam(item, componentName, paramName) {
  for (var ci = 0; ci < item.components.numItems; ci++) {
    var comp = item.components[ci];
    if (comp.displayName !== componentName) continue;
    for (var pi = 0; pi < comp.properties.numItems; pi++) {
      if (comp.properties[pi].displayName === paramName) return comp.properties[pi];
    }
  }
  return null;
}

// Writes props onto every item made from `template` (see ncTemplateKey);
// any other item is left untouched and counted as skipped. Returns counts
// for the panel to report.
function ncApplyPropsToItems(seq, props, items, template) {
  var s = { applied: 0, skipped: 0, failed: 0, restored: 0, animated: 0 };
  var p = null;
  try { p = Number(seq.getPlayerPosition().seconds); } catch (e) {}
  var refresh = null, refreshOnScreen = null;
  // A property that fails verification on one clip is skipped on the rest,
  // so whatever's wrong with it can only ever touch a single clip — and
  // that clip was already put back.
  var poisoned = {};
  // Every value changed, for ncUndo. Pushed onto the undo stack on the first
  // change rather than at the end, so a run that stops partway can still be
  // undone. A run that changes nothing adds no step.
  var journal = [];
  for (var ti = 0; ti < items.length; ti++) {
    var item = items[ti];
    if (template && ncTemplateKey(item) !== template) { s.skipped++; continue; }
    var matched = 0, missing = 0, clipRefresh = null;
    for (var i = 0; i < props.length; i++) {
      var want = props[i];
      var key = want.component + "\u0001" + want.name;
      var found = ncFindParam(item, want.component, want.name);
      if (!found) { missing++; continue; }
      matched++;
      if (poisoned[key]) { s.failed++; continue; }
      // Never flatten a target's own keyframes into a single value.
      var tv = false;
      try { tv = found.isTimeVarying(); } catch (e) {}
      if (tv) { s.animated++; continue; }
      var r;
      try { r = ncApplyOne(found, want, want.component); } catch (e) { r = { ok: false }; }
      if (r.ok) {
        if (r.refresh) {
          clipRefresh = r.refresh;
          if (!journal.length) ncPushUndoStep(journal);
          journal.push({ item: item, component: want.component, name: want.name, color: !!r.refresh.color,
            from: r.refresh.from, to: r.refresh.to, seen: r.refresh.seen });
        }
      } else { s.failed++; if (r.restored) { s.restored++; poisoned[key] = true; } }
    }
    // Matched none of the properties at all: not the same kind of clip.
    if (matched === 0 && missing > 0) { s.skipped++; continue; }
    s.failed += missing;
    s.applied++;
    if (clipRefresh) {
      refresh = clipRefresh;
      if (p !== null && ncItemCovers(item, p)) refreshOnScreen = clipRefresh;
    }
  }
  ncRefreshAfterApply(seq, refreshOnScreen || refresh, !!refreshOnScreen);
  return s;
}

// Undo / Redo for Paste and Sync All. Premiere's own Cmd+Z can't take these
// back cleanly: ExtendScript has no way to group a script's many writes into
// one undo step, and Premiere keeps only a limited number of history steps,
// so Cmd+Z walks back through a sync as many separate (mostly off-screen)
// steps — or past it, into older edits. Each Paste / Sync All is one step
// here instead. Kept in $.global, so it lasts until Premiere quits.
var NC_UNDO_LIMIT = 20;

function ncUndoStacks() {
  if (!$.global.ncUndoStack) $.global.ncUndoStack = [];
  if (!$.global.ncRedoStack) $.global.ncRedoStack = [];
  return { undo: $.global.ncUndoStack, redo: $.global.ncRedoStack };
}

// A new change makes the redo steps meaningless, as in any editor.
function ncPushUndoStep(entries) {
  var st = ncUndoStacks();
  st.undo.push(entries);
  if (st.undo.length > NC_UNDO_LIMIT) st.undo.shift();
  $.global.ncRedoStack = [];
}

// Entries in the last step (what Undo would act on).
function ncUndoableCount() {
  var u = ncUndoStacks().undo;
  return u.length ? u[u.length - 1].length : 0;
}

function ncUndoState() {
  var st = ncUndoStacks();
  return '{"undo":' + st.undo.length + ',"redo":' + st.redo.length + "}";
}

function ncStatsJson(s) {
  return '"applied":' + s.applied + ',"skipped":' + s.skipped + ',"failed":' + s.failed +
    ',"restored":' + s.restored + ',"animated":' + s.animated + ',"undoable":' + ncUndoableCount();
}

// Puts each entry's `from` back, but only where the value still holds
// exactly what that step left (`seen`) — anything changed since, by hand or
// by Cmd+Z, is left exactly as it is. Returns the counts plus the inverse
// entries, which Redo (or Undo, after a Redo) replays the same way.
function ncRevertEntries(entries) {
  var seq = app.project.activeSequence;
  var out = { reverted: 0, kept: 0, gone: 0, inverse: [] };
  var p = null;
  try { p = Number(seq.getPlayerPosition().seconds); } catch (e) {}
  var refresh = null, refreshOnScreen = null;
  for (var i = entries.length - 1; i >= 0; i--) {
    var en = entries[i];
    var param = null;
    try { param = ncFindParam(en.item, en.component, en.name); } catch (e) {}
    if (!param) { out.gone++; continue; } // clip deleted since
    try {
      var rec, back;
      if (en.color) {
        var cur = ncReadColor(param);
        if (!cur || !ncSame4(cur, en.seen)) { out.kept++; continue; }
        var order = ncWriteColor(param, en.from, false);
        if (order < 0) { ncWriteColor(param, cur, false); out.kept++; continue; }
        back = ncReadColor(param);
        rec = { color: true, param: param, from: en.to, to: en.from, order: order };
      } else {
        if (!ncSameValue(param.getValue(), en.seen)) { out.kept++; continue; }
        param.setValue(en.from, false);
        back = param.getValue();
        rec = { param: param, from: en.to, to: en.from };
      }
      out.reverted++;
      out.inverse.unshift({ item: en.item, component: en.component, name: en.name, color: en.color,
        from: en.to, to: en.from, seen: back });
      refresh = rec;
      if (p !== null && ncItemCovers(en.item, p)) refreshOnScreen = rec;
    } catch (e) { out.kept++; }
  }
  if (seq) ncRefreshAfterApply(seq, refreshOnScreen || refresh, !!refreshOnScreen);
  return out;
}

// Moves one step from one stack to the other, reverting it on the way.
function ncStepHistory(isRedo) {
  try {
    var st = ncUndoStacks();
    var fromStack = isRedo ? st.redo : st.undo, toStack = isRedo ? st.undo : st.redo;
    if (!fromStack.length) return '{"ok":false,"error":"Nothing to ' + (isRedo ? "redo" : "undo") + '."}';
    var r = ncRevertEntries(fromStack.pop());
    if (r.inverse.length) toStack.push(r.inverse);
    return '{"ok":true,"reverted":' + r.reverted + ',"kept":' + r.kept + ',"gone":' + r.gone +
      ',"undo":' + st.undo.length + ',"redo":' + st.redo.length + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

function ncUndo() { return ncStepHistory(false); }
function ncRedo() { return ncStepHistory(true); }

// Paste: applies copied props (a.props, from ncGetClipProperties) to every
// selected clip made from the same template as the copied clip (a.template).
function ncApplyClipProperties(argJson) {
  try {
    var a = (typeof argJson === "string") ? eval("(" + argJson + ")") : argJson;
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    var sel = ncSelectionArray(seq);
    if (!sel.length) return '{"ok":false,"error":"Select the clips to paste onto."}';
    var s = ncApplyPropsToItems(seq, a.props, sel, a.template || null);
    return '{"ok":true,' + ncStatsJson(s) + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}

// A caption's style, minus its own words — used to tell which caption was
// changed. Text run lengths are dropped too: they follow each caption's own
// text length, so they'd make every caption look different.
function ncStyleSignature(props) {
  var parts = [];
  for (var i = 0; i < props.length; i++) {
    var p = props[i], v = p.value;
    if (p.kind === "text") {
      v = String(v).replace(NC_TEXT_RE, '"textEditValue":""')
        .replace(/"[A-Za-z]*Run(Length|Count)[A-Za-z]*":(\[[^\]]*\]|-?[0-9.]+),?/g, "");
    }
    parts.push(p.component + "\u0001" + p.name + "\u0001" + JSON.stringify(v));
  }
  return parts.join("\u0002");
}

// Which selected caption is the changed one. Captions are compared within
// each template (style minus words): the style most of them share is the old
// one, so if exactly one other style is present, the caption(s) carrying it
// are the source. If that's ambiguous — several different changes, or no
// clear majority (e.g. just two captions) — the caption under the playhead
// is used, as long as it isn't one of the unchanged majority (you usually
// park on a caption to see it while editing it). Otherwise this refuses
// rather than guess: a wrong guess would overwrite the fresh edit.
function ncPickSyncSource(clips, p) {
  var groups = {}, keys = [], i;
  for (i = 0; i < clips.length; i++) {
    var c = clips[i];
    if (!groups[c.key]) { groups[c.key] = []; keys.push(c.key); }
    groups[c.key].push(c);
  }
  var comparable = false, anyDiff = false, ambiguous = false;
  var majority = {}, candidates = [], candidateSigs = {}, nCandidateSigs = 0;
  for (var g = 0; g < keys.length; g++) {
    var list = groups[keys[g]];
    if (list.length < 2) continue;
    comparable = true;
    var counts = {}, sigs = [];
    for (i = 0; i < list.length; i++) {
      if (!counts[list[i].sig]) { counts[list[i].sig] = 0; sigs.push(list[i].sig); }
      counts[list[i].sig]++;
    }
    if (sigs.length === 1) continue;
    anyDiff = true;
    var max = 0, maxSig = null, tie = false;
    for (i = 0; i < sigs.length; i++) {
      if (counts[sigs[i]] > max) { max = counts[sigs[i]]; maxSig = sigs[i]; tie = false; }
      else if (counts[sigs[i]] === max) tie = true;
    }
    if (tie || max < 2) { ambiguous = true; continue; }
    majority[keys[g]] = maxSig;
    for (i = 0; i < list.length; i++) {
      if (list[i].sig === maxSig) continue;
      var id = keys[g] + "\u0003" + list[i].sig;
      if (!candidateSigs[id]) { candidateSigs[id] = true; nCandidateSigs++; candidates.push(list[i]); }
    }
  }
  if (!comparable) return { error: "Select at least two captions made with the same MOGRT — the one you changed and the ones that should match it." };
  if (!anyDiff) return { source: null };
  if (nCandidateSigs === 1 && !ambiguous) return { source: candidates[0], reason: "changed" };
  if (p !== null) {
    for (i = 0; i < clips.length; i++) {
      var cl = clips[i];
      if (!ncItemCovers(cl.item, p) || groups[cl.key].length < 2) continue;
      if (majority[cl.key] === cl.sig) break; // unchanged — never spread the old style
      return { source: cl, reason: "playhead" };
    }
  }
  return { error: "Couldn't tell which caption you changed — more than one caption has its own style. Put the playhead on the caption to copy from and press Sync All again, or Copy that caption and Paste." };
}

// Sync All: no Copy needed. "Change one caption, select all, Sync All"
// spreads that caption's style to the other selected captions of the same
// template. (It used to paste whatever was last copied — which, if Copy
// wasn't pressed again after the edit, overwrote the fresh edit with the old
// style everywhere.)
function ncSyncSelection() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return '{"ok":false,"error":"No active sequence"}';
    var sel = ncSelectionArray(seq);
    var clips = [];
    for (var i = 0; i < sel.length; i++) {
      var key = ncTemplateKey(sel[i]);
      if (key === "plain") continue;
      var listed = ncListItemProperties(sel[i]);
      clips.push({ item: sel[i], key: key, props: listed.props, animated: listed.animated, sig: ncStyleSignature(listed.props) });
    }
    if (clips.length < 2) return '{"ok":false,"error":"Select the captions to sync — the one you changed and the ones that should match it. (Select All is fine: the video, audio and other clips are left alone.)"}';
    var p = null;
    try { p = Number(seq.getPlayerPosition().seconds); } catch (e) {}
    var pick = ncPickSyncSource(clips, p);
    if (pick.error) return '{"ok":false,"error":' + ncJsonStr(pick.error) + "}";
    if (!pick.source) return '{"ok":true,"same":true,"undoable":' + ncUndoableCount() + "}";
    var src = pick.source, targets = [];
    for (i = 0; i < sel.length; i++) if (sel[i] !== src.item) targets.push(sel[i]);
    var s = ncApplyPropsToItems(seq, src.props, targets, src.key);
    return '{"ok":true,"reason":' + ncJsonStr(pick.reason) + ',"sourceAt":' + ncStartSeconds(src.item) +
      ',"template":' + ncJsonStr(src.key) + ',"animated":' + src.animated +
      ',"properties":' + ncPropsJson(src.props) + "," + ncStatsJson(s) + "}";
  } catch (e) {
    return '{"ok":false,"error":' + ncJsonStr(e.toString()) + "}";
  }
}
