# Easy Automation — Project Rules

## Working folder
Always work in `C:\Github\Easy Automation`.

---

## Localization (i18n) — MANDATORY

The settings page (`settings/index.html`) supports **English and Norwegian** simultaneously via the `I18N` dictionary and `i18n()` function at the top of the main `<script>` block. Language is auto-detected from `navigator.language` at runtime.

### Rules for ALL UI changes to settings/index.html:

1. **Static HTML text** (buttons, labels, headings): add a `data-i18n="key"` attribute (or `data-i18n-html` for innerHTML with `<br>` etc). The `translateDOM()` function reads these on startup.
2. **Dynamic JS strings** (form labels generated in `_form*` functions): no code change needed — `translateFormDOM()` is called after every form renders and translates `.flabel`, `.check-row label`, `select option[value=""]`, `.slider-val`, `.lt-label`, `.dp-empty`, `.sec-hdr` (inside modal), and `.btn-sm` elements by looking up their text in the `I18N` dictionary.
3. **Error messages** (`throw new Error(...)`): use `i18n('err_key')`.
4. **Any new user-visible string**: add it to `I18N.en` AND `I18N.no` in both language objects.
5. **Never hardcode Norwegian-only strings** in JS — use `i18n()` so English users see English too.

### How translateFormDOM works
After `el('tmpl-body').innerHTML = TModal._form(type)`, `translateFormDOM()` is called. It scans the rendered DOM and replaces text nodes of known CSS classes if the text matches a key in `I18N[EA_LANG]`. This means form label strings in `_form*` functions **do not need `i18n()` calls** — just add the English→Norwegian pair to the dictionary.

### Adding a new template
- Add template button text: `data-i18n-html="tmpl_mytype"` on the `<span class="tmpl-name">` element
- Add modal title: `i18n('title_mytype')` in the `titles` dicts in `TModal.open()` and `TModal.openEdit()`
- Add both to `I18N.en` and `I18N.no`
- All form labels in `_formMyType()` are auto-translated if added to the dictionary
- **Always update the Help tab** — add a new entry in the Automation templates section of `view-help` with the template's icon, `data-i18n="help_tN_name"` and `data-i18n-html="help_tN_desc"`, plus both EN and NO strings in the `I18N` dictionary

---

## Help tab — KEEP UP TO DATE

The Help tab (`view-help` in `settings/index.html`) must always reflect the current state of the app. Every time a **new template** is added or an **existing template changes significantly**, update the Help tab:

1. **New template**: add a new icon+name+description block to the "Automation templates" card, with `data-i18n` attributes and both `I18N.en` and `I18N.no` entries.
2. **New optional feature** (e.g. a new toggle in a form): add or update the relevant section in the Help tab (e.g. "Optional features" card) so users know it exists.
3. **Changed behaviour**: update the description text in the Help tab to match — do not leave stale documentation.
4. Always add both EN and NO translations for any new text.

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

---

## Dark Mode in Homey Settings (settings/index.html)

Homey does NOT use `prefers-color-scheme: dark`, `.homey-dark-mode` classes, or any standard dark mode mechanism for settings pages. Instead:

### How it works
- Homey renders the settings page in **light mode** (`body.bg = #f2f2f7`).
- Dark mode is applied **externally** — likely via CSS `filter: invert()` or similar on a wrapper outside our HTML.
- `prefers-color-scheme: dark` = **false**
- `.homey-dark-mode` class = **never injected**
- Our CSS variables in `:root` are used as-is (light mode values).

### Key rules
1. **Design for light mode only** in `:root`. Do not rely on `@media (prefers-color-scheme: dark)` or `.homey-dark-mode` — they never trigger. Keep them for correctness but the `:root` values are what matter.
2. **Use pure `#000000` for text colors** — Homey's inversion turns `#000000` → white. Off-blacks like `#1c1c1e` invert to gray, not white.
3. **Homey overrides `<label>` elements globally** with a gray color (`rgb(97,97,97)`). Always add `!important` when setting color on labels:
   ```css
   label { color: var(--ea-text) !important; }
   .flabel { color: var(--ea-text) !important; }
   .check-row label { color: var(--ea-text) !important; }
   ```
4. **`<div>`, `<h2>`, `<input>`, `<span>` inherit color correctly** — no `!important` needed.
5. **Never use JavaScript to detect or force dark mode** — it doesn't work because Homey applies dark mode outside our DOM.
6. **Avoid hardcoded color values in inline styles** — always use CSS variables (`var(--ea-text)`) so everything stays consistent.
7. **Use a debug banner to diagnose color issues:**
   ```javascript
   // Add temporarily, check computed colors on different element types
   setTimeout(function() {
     var flabel = document.querySelector('.flabel');
     console.log('flabel color:', getComputedStyle(flabel).color);
   }, 1000);
   ```

### Current color tokens (`:root`)
| Variable       | Value     | Purpose                   |
|---------------|-----------|---------------------------|
| `--ea-text`    | `#000000` | Primary text (inverts to white) |
| `--ea-sub`     | `#000000` | Secondary text (inverts to white) |
| `--ea-bg`      | `#f2f2f7` | Page background           |
| `--ea-surface` | `#ffffff` | Card/surface background   |
| `--ea-border`  | `#e0e0e5` | Borders                   |
| `--ea-accent`  | `#e8622a` | Orange accent             |
