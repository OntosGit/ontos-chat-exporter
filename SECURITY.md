# Security considerations

- **Host restriction:** Only `https://chatgpt.com/*` is configured in the manifest. Conversation HTTP calls are made with `fetch` to relative first-party URLs. The code checks the hostname and request path.
- **File output:** HTML escapes message text before putting it in `<pre>` blocks. The local Reader uses `textContent` for list labels and status updates. Exports are downloaded via `Blob` URLs.
- **Authentication:** Existing ChatGPT session only; no API key or password entry. Access tokens, when available, are held in memory only for first-party requests.
- **No audio capture:** No microphone, tab capture, screen recording, or media permissions.
- **No remote analytics or script dependencies.**
- **Limitations:** The Reader does not verify ZIP CRC and cannot protect against every deliberately malformed or decompression-bomb archive. Use trusted archives and avoid opening untrusted giant ZIP files. ChatGPT may change private endpoints and return errors or incomplete metadata.

Please report potential vulnerabilities **without real conversations, cookies, or bearer tokens**. For an accidental disclosure, do not post it publicly; contact the repository maintainer privately through their GitHub profile.
