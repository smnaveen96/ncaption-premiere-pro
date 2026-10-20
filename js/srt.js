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

  // ---- Phrase splitting ----
  // The phrases for a caption are chosen all at once (shortest path over the
  // gaps between its words) instead of filling each phrase greedily, so that:
  //   · no phrase is a single word left on its own — "you?" after "Hi, how
  //     are" — unless the caption itself is one word, or the limit is one
  //     word per phrase;
  //   · phrases come out as even in length as the limit allows, rather than
  //     full, full, full, stub;
  //   · a break lands after sentence or clause punctuation when that costs
  //     little.
  // The limit holds whenever a no-orphan split exists within it. When none
  // does (three words at two per phrase), one phrase may run over by a
  // small, bounded amount — one word, or about a quarter of the character
  // limit — rather than leave a word hanging. Past that bound the orphan is
  // kept: a 10-character limit shouldn't produce 30-character phrases.
  //
  // Costs are in "slack" units: a phrase's shortfall from the limit, squared
  // and scaled to [0, 1). The other costs are sized against that: an orphan
  // outweighs any amount of unevenness, and running over the limit always
  // loses to any split that stays within it.
  const ORPHAN = 6;
  const OVER_BASE = 2;
  const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
  const CLAUSE_END = /[,;:]["'”’)\]]*$/;

  function splitWords(words, max, byWords) {
    const W = words.length;
    if (W <= 1) return words.slice();
    const L = Math.max(1, max | 0);
    const tol = byWords ? 1 : Math.max(6, Math.ceil(L / 4));
    const orphans = !(byWords && L === 1);
    // pre[i]: characters in words[0..i), counting a space after each word.
    const pre = [0];
    for (const w of words) pre.push(pre[pre.length - 1] + w.length + 1);
    const lenOf = (a, b) => (byWords ? b - a : pre[b] - pre[a] - 1);

    // Cost of words[a..b) as one phrase; Infinity if it may not be one.
    function cost(a, b) {
      const n = b - a, len = lenOf(a, b);
      let c;
      if (len <= L) c = ((L - len) / L) ** 2;
      else {
        if (n > 1 && len - L > tol) return Infinity;
        const over = Math.min(len - L, tol); // a lone word longer than the limit can't be helped
        c = OVER_BASE + 2 * (over / tol) ** 2;
      }
      if (n === 1 && orphans) c += ORPHAN;
      if (b < W) {
        if (SENTENCE_END.test(words[b - 1])) c -= 0.4;
        else if (CLAUSE_END.test(words[b - 1])) c -= 0.2;
      }
      // Tie-break only (far below any real difference): of equally good
      // splits, the one whose earlier phrases are the shorter ones.
      return c + 1e-7 * (len / L) ** 2 * (W - b);
    }

    const best = new Array(W + 1).fill(Infinity);
    const cut = new Array(W + 1).fill(0);
    best[0] = 0;
    for (let b = 1; b <= W; b++) {
      for (let a = b - 1; a >= 0; a--) {
        const c = cost(a, b);
        if (c === Infinity) break; // a longer span can only be longer still
        if (best[a] + c < best[b]) { best[b] = best[a] + c; cut[b] = a; }
      }
    }
    const phrases = [];
    for (let b = W; b > 0; b = cut[b]) phrases.unshift(words.slice(cut[b], b).join(" "));
    return phrases;
  }

  // Splits cues into phrases of at most `max` characters or words (see
  // splitWords); time stays proportional to phrase text length. Each phrase
  // records which source cue it came from (src), so edits made to phrases
  // can be written back to the source and survive a re-split.
  function splitCues(source, max, unit) {
    const out = [];
    const byWords = unit === "words";
    source.forEach((cue, src) => {
      const words = cue.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
      const phrases = splitWords(words, max, byWords);
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

  NC.srt = { parseSrt, splitWords, splitCues, toSrt };
})((window.NC = window.NC || {}));
