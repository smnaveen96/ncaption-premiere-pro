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
- **FFmpeg**, for audio extraction and compression: `brew install ffmpeg`. If it isn't installed, the panel shows that command with a Copy button at the top and notices by itself once the install finishes. If it's installed but can't start (a Homebrew upgrade can break it), the panel says so and shows `brew reinstall ffmpeg` instead.
- **Optional:** a Claude or OpenAI API key for AI cleanup.

Whisper itself needs no setup. The panel downloads the models you choose and a small `whisper-cli` runtime for your Mac (Apple Silicon or Intel). Every download is checked against a pinned SHA-256 checksum.

## Install

The panel isn't signed, so Premiere has to be told to load unsigned extensions. Install takes three steps.

### 1. Put the folder in Premiere's extensions folder

Download the ZIP from the latest release (or **Code → Download ZIP**) and unzip it. Then move the folder here and rename it `ncaption-cep`:

| | Extensions folder |
| --- | --- |
| **macOS** | `~/Library/Application Support/Adobe/CEP/extensions/` |
| **Windows** | `%APPDATA%\Adobe\CEP\extensions\` (usually `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\`) |

If the `CEP` or `extensions` folder doesn't exist yet, create it.

On macOS, `~/Library` is hidden. In Finder, choose **Go → Go to Folder…** and paste the path. On Windows, paste the path into File Explorer's address bar.

The result should look like this. `CSXS` must sit directly inside `ncaption-cep`, not one folder deeper:

```
extensions/
└── ncaption-cep/
    ├── CSXS/manifest.xml
    ├── index.html
    ├── js/
    └── jsx/
```

With git, you can clone straight into place instead:

```sh
# macOS
git clone <this-repo-url> ~/Library/Application\ Support/Adobe/CEP/extensions/ncaption-cep
# Windows (Command Prompt)
git clone <this-repo-url> "%APPDATA%\Adobe\CEP\extensions\ncaption-cep"
```

### 2. Allow unsigned panels (run once)

**macOS:** in Terminal:
```sh
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

**Windows:** in Command Prompt:
```bat
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### 3. Open it

Quit and reopen Premiere Pro, then choose **Window → Extensions → nCaption**.

To update later, replace the folder with the new version, or run `git pull` inside it. Then reopen the panel.

> Windows support hasn't been tested yet. Please open an issue if something doesn't work.

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

## License

[MIT](LICENSE). `lib/CSInterface.js` is Adobe's CEP library, distributed under Adobe's own terms.

<--level Documentation update -->
