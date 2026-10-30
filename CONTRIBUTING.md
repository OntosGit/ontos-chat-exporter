# Contributing

Thanks for testing ONTOS Chat Exporter.

- Open an issue with a short reproduction, Edge/Chrome version, extension version, and redacted error text.
- Never include exported real conversations, cookies, tokens, passwords, or confidential screenshots.
- Include a synthetic fixture and a regression test for parser or pagination changes.
- Run `node --test tests/*.test.cjs` locally and document any limitations.
- Keep network calls first-party, permissions minimal, and the core usable without external dependencies.
- Do not claim an export is complete when its source pagination/branch metadata is missing or contradictory.
- Please keep public changes independent of the owner's private ONTOS projects.
