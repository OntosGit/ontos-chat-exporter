# Privacy model

ONTOS Chat Exporter has no server, telemetry, ads, tracking, third-party analytics, account database, or remote configuration. All processing and downloads run in your local browser. The extension requests data only from first-party `chatgpt.com` endpoints in the already signed-in session.

When an export is initiated, the extension accesses the selected conversation and may read the first-party session endpoint to authorize the request. This is used only in memory to fetch the conversation. No authentication tokens are written to the output by the extension itself, but the **raw conversation JSON can include sensitive information returned by the service**. The extension does not inspect or strip secrets from the original JSON.

Markdown and HTML exports omit service/tool records and render text from visible user/assistant messages; these text messages can still include personal information. Media/voice recording is not implemented.

The extension needs the Chromium `activeTab`, `storage`, and `unlimitedStorage` permissions, plus `https://chatgpt.com/*` host permission. `unlimitedStorage` avoids the default storage quota for large conversations; it does not make storage infinite. A declared content script is loaded on ChatGPT tabs, but the export command only acts on the selected active tab and conversation ID.

Users control the resulting files and any later sharing. Do not attach raw conversation exports to public GitHub issues, commits, or pull requests. Redact screenshots and console logs.

## Resumable checkpoints (v1.4)

Each successfully received page of the selected conversation is saved under a conversation-specific key in Chrome/Edge extension-local storage. The cache includes raw messages, pagination cursors, conversation metadata, and a page manifest. It **never stores the authorization header or session token**. Pages remain until reset, extension removal, or browser-profile storage cleanup. A completed conversation can be re-exported without network requests; reset its checkpoint to capture later edits. Do not use a shared browser profile for private conversation exports.
