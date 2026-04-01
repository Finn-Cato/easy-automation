# Easy Automation — Project Rules

## Working folder
Always work in `C:\Github\Styring av lys og automasjoner`.

---

## Publishing to Homey App Store

Do all of the following automatically — no need to ask the user for confirmation on these steps:

### 1. Version bump
- Increment the **patch version by exactly 0.0.1** every time — e.g. 0.1.1 → 0.1.2.
- Never skip versions. Never bump minor or major unless the user explicitly asks.
- Update the version in `app.json`.

### 2. Changelog
- Check `git log` since the last published version to find all commits made since the last Homey App Store upload.
- Use those commits to write the changelog entry — do not make it up.
- Add the entry to `.homeychangelog.json` in **both** `en` (English) and `no` (Norwegian Bokmål).
- Do this automatically without asking the user.

### 3. Pre-publish checklist (all automatic)
- [ ] Version bumped by exactly 0.0.1 in `app.json`
- [ ] `.homeychangelog.json` updated in both EN and NO based on git log
- [ ] All changes committed and pushed to GitHub
- [ ] `homey app publish` run — answer **No** if the CLI asks to bump version (already done manually)

### 4. Full permissions
The user has granted full permission to publish without asking any questions. Never ask the user to confirm version numbers, changelog text, or any publish step. Just do it.

---

## After every code change
Use `homey app install` (permanent, keeps settings) — NOT `homey app run` (temporary debug session only).

---

## Committing to GitHub
- Write clear commit messages describing *why* the change was made.
- Never bump the version without also updating `.homeychangelog.json`.

---

## General
- NEVER run `homey app publish` unless the user explicitly asks to publish to the App Store.
- The `.homeyignore` file must exclude all dev-only files.
- `CLAUDE.md` is the authoritative rules file for this project — always read it before doing any work.
