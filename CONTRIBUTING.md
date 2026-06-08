# Contributing to Drive Dupe Destroyer

Thanks for your interest in improving Drive Dupe Destroyer. Bug reports, fixes,
and feature ideas are all welcome.

## License of contributions

This project is licensed under the **PolyForm Noncommercial License 1.0.0** (see
[`LICENSE`](LICENSE)). By submitting a contribution (a pull request, patch, or
suggested change), you agree that your contribution is provided under those same
PolyForm Noncommercial 1.0.0 terms, and you confirm that you wrote it or
otherwise have the right to submit it under that license.

Please note this is a *noncommercial, source-available* license, not an
OSI-approved open-source license: the project (and contributions to it) may be
used for noncommercial purposes only. If you have a commercial use in mind, or
want to contribute under different terms, open an issue to discuss first.

> The author may also choose to offer the software under separate commercial
> terms. For a small fix this is not a concern; for a substantial contribution,
> the author may ask you to confirm in writing that the author can also use your
> contribution under those separate terms. (Not legal advice — if a contribution
> matters a lot to you, talk to your own advisor.)

## Reporting bugs and requesting features

Use the issue templates (Bug report / Feature request). For sign-in problems,
please read the README's **Google OAuth Setup** section first.

**Privacy:** this app works directly with your Google Drive. When attaching
screenshots or console logs to an issue, blur or remove personal file names,
folder names, and image content. Never paste an access token. Never paste your
OAuth **client secret** — it is not used by the app and should not appear
anywhere.

## Development setup

Drive Dupe Destroyer is a static browser app — vanilla JavaScript ES modules,
no build step, no backend.

1. Clone the repo:
   ```bash
   git clone https://github.com/CarlosCamacho/Drive-Dupe-Destroyer.git
   cd Drive-Dupe-Destroyer
   ```
2. Run the local secure server (sends the COOP/COEP/CSP headers the app expects):
   ```bash
   python3 serve_secure.py      # Windows: python serve_secure.py
   ```
3. Open `http://localhost:8080`.
4. For testing, **use your own Google OAuth Client ID** (create a Google Cloud
   project, OAuth client of type *Web application*, add `http://localhost:8080`
   under *Authorized JavaScript origins*; the client secret is not needed). See
   the README for the full walkthrough. Do not commit any Client ID, token, or
   secret.

## Coding guidelines

- Keep it dependency-free and framework-free; plain ES modules, no build tooling.
- Match the existing style (formatting, naming, module boundaries).
- Every source file starts with the standard header carrying
  `SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0` and the copyright line.
  Copy that header onto any new file you add.
- Run a syntax check before opening a PR:
  ```bash
  for f in js/*.js sw.js; do node --check "$f"; done
  python3 -m py_compile serve_secure.py
  ```
- Keep changes focused; one logical change per pull request.

## Pull request process

1. Fork and create a branch off `main`.
2. Make your change and verify it in the browser.
3. If it's a user-facing change, add a note to [`CHANGELOG.md`](CHANGELOG.md)
   under a new version heading (newest first).
4. Open the PR with a clear description of what changed and why. PRs are squash-
   merged.

Thanks again for helping make the project better.
