# ONTOS Chat Exporter

**Download one ChatGPT conversation as Markdown, HTML, or raw JSON, without scrolling.**

A small, open-source extension for Chromium-based browsers (tested in Microsoft Edge). It reads the **currently active conversation**, including chats inside ChatGPT projects, and saves a local file. No hosted account, analytics, third-party upload, or OpenAI API key required.

**Status:** experimental, version 1.3.1. Verified on one real export on 30 October 2026 and tested offline with synthetic fixtures. This is **not an official OpenAI product**. ChatGPT's internal endpoints can change without notice.

[Русская инструкция](README.ru.md)

## What it exports

| Output | Purpose | Included |
|---|---|---|
| **Markdown** (`.md`) | Attach to another chat or search locally | Text of visible user/assistant messages, main branch |
| **HTML** (`.html`) | Read a static local copy | Same text, all extracted messages in one document |
| **Raw JSON** (`.json`) | Audit and re-process original response | Original conversation data, including tool/service records returned by ChatGPT |

**Important:** Raw JSON can contain sensitive data, tool results, metadata, and references to attachments. Markdown/HTML may also contain sensitive chat text. Nothing is automatically scrubbed; review exports before sharing them.

The code downloads **one conversation**, not all tabs or your entire account. Browser permissions allow the content script to load on `chatgpt.com`, but an export is initiated only for the active tab's `/c/<conversation-id>` URL.

## Install on Microsoft Edge

1. Download this repository as a ZIP (**Code → Download ZIP**) and extract it to a permanent folder.
2. Open `edge://extensions`.
3. Enable **Developer mode** and click **Load unpacked**.
4. Select the **`extension/`** folder containing `manifest.json`.
5. Open the ChatGPT conversation you want to save and refresh the tab (`Ctrl+R`).
6. Click the extension icon and choose **Download conversation as Markdown**, **Save HTML**, or **Save raw JSON**.
7. Find your file in the browser downloads (`Ctrl+J`).

If the extension shows `Blocked`, check Edge's **per-site extension access setting** for `chatgpt.com`. In Edge, extensions may be disabled for a site even when the extension itself is enabled. Do not disable global browser security settings.

## Local Reader

Open [`reader/ONTOS_Reader.html`](reader/ONTOS_Reader.html) directly in Edge or another modern browser. Choose a saved conversation JSON or the official ChatGPT data-export ZIP. It runs locally and lets you select a conversation and save Markdown or HTML. ZIP64 and unsupported compression methods require extracting the ZIP first.

The Reader supports this extension's one-conversation JSON and many conventional `conversations.json`/`conversations-000.json` archives.

## What it cannot guarantee

- It relies on **undocumented, authenticated ChatGPT endpoints**. An HTTP 500, 403, changed response shape, or site policy can break it.
- Pagination and parent-chain checks detect several truncation cases; they cannot prove that ChatGPT supplied every deleted, hidden, or historical message.
- Markdown/HTML contain the **main visible conversation branch**, not all alternatives, tool logs, or internal service messages. Keep the raw JSON when you need a technical archive.
- Binary attachments, images, audio, voice playback, files, and interactive widgets are **not downloaded**. Some may appear as text placeholders.
- In-progress assistant turns can be incomplete. Wait for completion before exporting whenever possible.
- The Reader parses standard ZIP entries but does not independently verify ZIP CRC checksums; protect archives using external file hashes if required.

## Privacy and permissions

- Manifest v3, `activeTab` and `https://chatgpt.com/*` host access only.
- No extension backend, telemetry, cookies storage, microphone recording, tab audio capture, or third-party network requests.
- The extension calls ChatGPT's first-party session endpoint and first-party conversation endpoints within your signed-in browser session, then downloads a file locally.
- Technical JSON can contain far more data than the visible chat. **Do not commit real exported conversations to public repositories.**

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Developing

Requires **Node.js 20+** only for tests. The extension itself needs no build step.

```bash
node --test tests/*.test.cjs
```

Fixtures in `tests/fixtures/` are synthetic and contain no actual conversations. No GitHub Actions workflow is included; tests can run locally or on your own runner.

## Feedback

If you use it, a GitHub ⭐ helps other people find it. Bug reports, compatibility reports for recent Edge/Chrome versions, and pull requests are welcome. Please **remove personal chat text, cookies, and tokens** from reports and screenshots.

## License

MIT, see [LICENSE](LICENSE).

**Disclaimer:** Independent community tool; not endorsed by or affiliated with OpenAI. “ChatGPT” is a trademark of its respective owner.
