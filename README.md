# NT2 School Collectie Downloader

Automated script to download books from NT2 School Collectie using Playwright.

## Features

- **Persistent session**: Login once, stays logged in for future runs
  - Browser profile saved in `.browser-data/` directory
  - Smart login detection: checks for print button availability
  - Verifies book access before downloading
  - Auto-navigates to book after successful login
- No hardcoded credentials or cookies
- Manual login in browser (prompted only when needed)
- **Robust auto-detection**:
  - Title from `document.title`
  - Page count from multiple sources:
    1. Schema.org JSON-LD metadata
    2. "XXX pagina's" text pattern
    3. "X / Y" toolbar indicator
    4. Full page scan fallback
- Manual input fallback if auto-detection fails
- Resume capability (skips already downloaded spreads)
- Automatic PDF merging
- Optional page limit for testing
- Books organized by ISBN in separate directories

## Prerequisites

```bash
npm install
```

## Usage

### Full book download:

```bash
node download-book-automated.js <book-url>
```

Example:
```bash
node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609
```

### Test with limited pages:

```bash
node download-book-automated.js <book-url> <page-limit>
```

Example (download only first 10 pages):
```bash
node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 10
```

### Multiple books:

Download multiple books by providing multiple URLs:

```bash
node download-book-automated.js <url1> <url2> <url3>
```

Example (download two books sequentially):
```bash
node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 https://www.nt2schoolcollectie.nl/boek/9789046908426
```

Example (download two books in parallel with `--parallel` flag):
```bash
node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 https://www.nt2schoolcollectie.nl/boek/9789046908426 --parallel
```

**How it works:**
- Each book uses its own isolated browser profile: `.browser-data-[ISBN]/`
- You'll need to log in separately for each book (only once per book)
- Sequential mode downloads one after another (default)
- Parallel mode downloads simultaneously (use `--parallel` flag)
- Single book mode uses shared `.browser-data/` profile

### Clear browser cache:

Use the `--clear-cache` flag to delete saved login session and browser data:

```bash
node download-book-automated.js <book-url> --clear-cache
```

Example:
```bash
node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 --clear-cache
```

This is useful when:
- You want to log in with a different account
- Troubleshooting login issues
- Starting fresh after errors

## How it works

1. Opens browser with persistent profile (saves login session in `.browser-data/`)
2. Navigates to the book URL
3. Auto-detects if already logged in
   - If logged in: Continues automatically
   - If not logged in: Prompts you to log in manually
4. Detects book title and total pages automatically
5. Downloads each 2-page spread as PDF
6. Merges all spreads into single PDF
7. Output saved to `../[book-title].pdf`

**Note**:
- Login is saved in `.browser-data/` directory
- Subsequent runs will auto-detect your saved session
- Only prompts for login when needed
- Session persists until website logout or cookie expiration

## File Structure

- `spreads/[book-id]/` - Individual spread PDFs
- `../[book-title].pdf` - Final merged book

## Resume Downloads

The script automatically skips already downloaded spreads. If interrupted, simply run the same command again to resume.

## Troubleshooting

### Login not being saved

If you're prompted to login every time:

1. Make sure the `.browser-data/` directory exists and has proper permissions
2. Try clearing the cache and logging in again: `node download-book-automated.js <book-url> --clear-cache`
3. Ensure Chrome is properly installed (the script uses Chrome, not Chromium)

### Login detection issues

The script uses smart login detection:

- Checks for the `#print-pdf` button (the actual functionality needed)
- If button is missing AND login indicators are present, prompts for login
- Verifies button exists after login - if not, exits with error message
- This ensures you have actual access to download the book

If you get "Print button not found" error:
- You may not have permission to access this book
- Check your subscription or library access
- Try logging in manually in the browser first
