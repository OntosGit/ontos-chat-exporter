# Privacy model

ONTOS Chat Exporter has no server, telemetry, ads, tracking, third-party analytics, account database, or remote configuration. All processing and downloads run in your local browser. The extension requests data only from first-party `chatgpt.com` endpoints in the already signed-in session.

When an export is initiated, the extension accesses the selected conversation and may read the first-party session endpoint to authorize the request. This is used only in memory to fetch the conversation. No authentication tokens are written to the output by the extension itself, but the **raw conversation JSON can include sensitive information returned by the service**. The extension does not inspect or strip secrets from the original JSON.

Markdown and HTML exports omit service/tool records and render text from visible user/assistant messages; these text messages can still include personal information. Media/voice recording is not implemented.

The extension needs the Chromium `activeTab` permission plus `https://chatgpt.com/*` host permission. A declared content script is loaded on ChatGPT tabs, but the export command only acts on the selected active tab and conversation ID.

Users control the resulting files and any later sharing. Do not attach raw conversation exports to public GitHub issues, commits, or pull requests. Redact screenshots and console logs.
