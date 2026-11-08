# Changelog

## 1.4.0 · 2026-11-08 · resumable page-by-page export

- Save every successful page in extension-local storage before advancing the page cursor.
- Resume the same conversation after browser reload, popup closure, timeouts, and HTTP 429.
- Respect `Retry-After` or apply bounded exponential cooldown; avoid redundant requests to previously saved pages.
- Offer 5/8/20/unlimited-page batches, progress counters, manual continuation, and explicit cache reset.
- Validate page integrity, duplicate IDs, and message normalization before marking an archive complete.
- Add synthetic regression tests covering resumed batches, HTTP 429, storage failure, loops, and reset.
- Expand `storage` and `unlimitedStorage` permissions for larger conversation caches.

## 1.3.1 · 2026-10-30 · public-source preparation

- Prepared a redacted, independent GitHub distribution without user conversation dumps or real screenshots.
- Added bilingual instructions, MIT license, privacy and security notes, and synthetic regression tests.
- Made JSON sensitivity clearer in the popup and clarified that no audio is captured.
- Retained the core export behavior of the locally tested 1.3 release.

## 1.3.0 · 2026-10-30

- Added Markdown output, raw JSON output and static HTML output.
- Filtered visible conversation messages from hidden reasoning/service records.
- Supported active chat inside project URLs.
- Supported long conversations through paginated first-party history where available.
- Added an offline HTML reader for single-chat JSON and conventional ChatGPT ZIP archives.
