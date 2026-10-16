// SRT parsing and phrase splitting.
(function (NC) {
  function parseTime(h, m, s, ms) { return +h * 3600 + +m * 60 + +s + +ms.padEnd(3, "0") / 1000; }

  const NOISE = /^[\[\(].*[\]\)]$/; // e.g. [BLANK_AUDIO], (music)

  function parseSrt(text) {
    const re = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;
    return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)
      .map((block) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        const i = lines.findIndex((l) => re.test(l));
        if (i === -1) return null;
        const t = lines[i].match(re);
        return {
          start: parseTime(t[1], t[2], t[3], t[4]),
          end: parseTime(t[5], t[6], t[7], t[8]),
          text: lines.slice(i + 1).join("\n").replace(/<[^>]+>/g, "").trim(),
        };
      })
      .filter((c) => c && c.text && !NOISE.test(c.text));
  }

  // Splits cues by character or word count; time remains proportional to phrase text length.
  // Each phrase records which source cue it came from (src), so edits made to
  // phrases can be written back to the source and survive a re-split.
  function splitCues(source, max, unit) {
    const out = [];
    const byWords = unit === "words";
    source.forEach((cue, src) => {
      const words = cue.text.replace(/\s+/g, " ").trim().split(" ");
      const phrases = [];
      let line = "";
      let lineWords = 0;
      for (const w of words) {
        const exceeds = byWords ? lineWords >= max : (line + " " + w).length > max;
        if (line && exceeds) { phrases.push(line); line = w; lineWords = 1; }
        else { line = line ? line + " " + w : w; lineWords++; }
      }
      if (line) phrases.push(line);
      const total = phrases.join("").length || 1;
      const dur = cue.end - cue.start;
      let t = cue.start;
      for (const p of phrases) {
        const d = (dur * p.length) / total;
        out.push({ start: t, end: t + d, text: p, src });
        t += d;
      }
    });
    return out;
  }

  function formatTime(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const pad = (n, len) => String(n).padStart(len || 2, "0");
    return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`;
  }

  function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}`).join("\n\n") + "\n";
  }

  NC.srt = { parseSrt, splitCues, toSrt };
})((window.NC = window.NC || {}));
