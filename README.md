# nCaption

An Adobe Premiere Pro panel that turns your timeline audio into animated captions.

Transcribe on your own machine with Whisper, or import an SRT. Split the text into short phrases and optionally clean it up with Claude or OpenAI. Then place one MOGRT caption per phrase on the timeline. The panel can also copy or sync caption styles, and render and compress the finished sequence.

## Features

**Captions tab**
1. **Transcribe** the selected timeline clips locally with whisper.cpp; nothing is uploaded. You can also import or drag in an `.srt` file. Open the **Transcript** dropdown to read it with timecodes and copy it.
2. **Phrase length** sets the maximum characters or words per caption. A live count shows how many captions you'll get.
3. **AI cleanup** (optional) fixes spelling, punctuation and brand names using your own prompt or client guidelines.
   - You review every change before it's applied.
   - Applied changes stay in a list: untick some and apply again whenever you like.
   - Changing the phrase length afterwards keeps the cleanup.
4. **Caption style:** pick a MOGRT (one is bundled, or add your own) and a video track, then click **Create subs**. **Export SRT** saves the phrases as a subtitle file.
5. **Copy / Paste / Sync All** for caption style.
   - Restyle one caption, select all captions, and click **Sync All**. That caption's look goes to the rest, and every caption keeps its own words.
   - **Undo / Redo** in the panel steps through Paste and Sync All. Premiere's Cmd+Z can't undo a whole Sync All in one step.

**Render & Compress tab**
- Renders the sequence inside Premiere, either the full sequence or In/Out. No Media Encoder is needed.
- Compresses the render with FFmpeg at Normal, Medium or Small. MP4 is the default; MOV keeps transparency.

## Requirements

- **Adobe Premiere Pro 2022 (v22) or later.** This is a CEP panel.
- **macOS.** Windows paths exist in the code but haven't been tested.
- **FFmpeg**, for audio extraction and compression: `brew install ffmpeg`.
- **Heebo font**, for the bundled `ncaption.mogrt`. MOGRTs don't embed fonts. It's free on [Google Fonts](https://fonts.google.com/specimen/Heebo).
- **Optional:** a Claude or OpenAI API key for AI cleanup.

Whisper itself needs no setup. The panel downloads the models you choose and a small `whisper-cli` runtime for your Mac (Apple Silicon or Intel). Every download is checked against a pinned SHA-256 checksum.

## Install

The panel isn't signed, so Premiere has to be told to load unsigned extensions.

1. Allow unsigned panels (run once in Terminal):
   ```sh
   defaults write com.adobe.CSXS.11 PlayerDebugMode 1
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1
   ```
2. Put this folder in Premiere's extensions folder:
   ```sh
   git clone <this-repo-url> ~/Library/Application\ Support/Adobe/CEP/extensions/ncaption-cep
   ```
3. Restart Premiere Pro, then open **Window → Extensions → nCaption**.

To update later, run `git pull` in that folder and reopen the panel.

## First run

1. Open **1 · Transcribe → Models** and download a model. *Whisper Small (English only)* is a good default.
2. Select clips on the timeline and click **Transcribe selected clips**. With nothing selected, it uses audio track 1.
3. Set the phrase length, choose a MOGRT and a track, and click **Create subs**.

## Privacy

- Transcription runs entirely on your Mac.
- AI cleanup sends the caption text, and nothing else, to the provider you choose (Anthropic or OpenAI) using your own API key.
- API keys are stored in the macOS Keychain, never in this folder.
- Models, the Whisper runtime and your own MOGRTs are stored in `~/Library/Application Support/nCaption/`, outside the repo.

## Project layout

| Path | What it does |
| --- | --- |
| `CSXS/manifest.xml` | CEP manifest (panel id, size, Node enabled) |
| `index.html`, `style.css` | Panel UI |
| `js/main.js` | Captions tab: transcription, phrases, AI review, MOGRT insert, SRT export |
| `js/sync.js` | Copy / Paste / Sync All, Undo / Redo |
| `js/render.js`, `js/compress.js` | Render & Compress tab |
| `js/srt.js` | SRT parsing, phrase splitting, SRT writing |
| `js/models.js` | Model catalogue and checksummed downloads |
| `js/transcribe.js` | FFmpeg audio extraction and whisper.cpp |
| `js/ai.js`, `js/prompts.js`, `js/diff.js`, `js/keystore.js` | AI cleanup, prompt library, review diff, Keychain storage |
| `jsx/host.jsx` | ExtendScript that runs inside Premiere: clips, MOGRT insert, style copy/sync, render |
| `assets/mogrt/` | Bundled caption MOGRT |
| `lib/CSInterface.js` | Adobe's CEP library |

## Development

- Edit files in place. Then close and reopen the panel, or right-click it and choose **Reload**.
- `jsx/host.jsx` is cached by Premiere. Reopen the panel after you change it, and restart Premiere if it still doesn't pick up the change.
- **Panel debugging:** while Premiere is running, open <http://localhost:8088> in Chrome. The port is set in `.debug`.
- **ExtendScript debugging:** use VS Code with Adobe's *ExtendScript Debugger* extension, attached to Premiere.

## Known limitations

- Premiere flickers briefly while captions are being placed. That's Premiere redrawing as each clip is added, and scripts can't pause it.
- Premiere's scripting can't read keyframe easing, so Copy / Sync All skips animated (keyframed) controls rather than flattening them.

## License

[MIT](LICENSE). `lib/CSInterface.js` is Adobe's CEP library, distributed under Adobe's own terms.
