const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// Parse command line arguments
const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith('--'));
const positional = args.filter(arg => !arg.startsWith('--'));

const CLEAR_CACHE = flags.includes('--clear-cache');
const ISOLATED = flags.includes('--isolated');
const BOOK_URL = positional[0];
const PAGE_LIMIT = positional[1] ? parseInt(positional[1], 10) : null;

if (!BOOK_URL) {
  console.error('Usage: node download-book-automated.js <book-url> [page-limit] [--clear-cache] [--isolated]');
  console.error('Example: node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609');
  console.error('Example with limit: node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 10');
  console.error('Example with cache clear: node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 --clear-cache');
  console.error('Example with isolated profile: node download-book-automated.js https://www.nt2schoolcollectie.nl/boek/9789046905609 --isolated');
  process.exit(1);
}

// Extract book ID from URL
const bookIdMatch = BOOK_URL.match(/\/boek\/(\d+)/);
if (!bookIdMatch) {
  console.error('Invalid book URL. Must contain /boek/[ISBN]');
  process.exit(1);
}
const BOOK_ID = bookIdMatch[1];

let TOTAL_PAGES = null; // Will be detected from the page
let BOOK_TITLE = null; // Will be detected from the page
const PAGES_PER_SPREAD = 2;
const OUTPUT_DIR = path.join(__dirname, 'spreads', BOOK_ID);

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function waitForUserLogin(page) {
  console.log('\n==========================================================');
  console.log('Please log in to the website in the browser window.');
  console.log('Once logged in and you can see the book, press ENTER here...');
  console.log('==========================================================\n');

  // Wait for user to press Enter
  await new Promise((resolve) => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    readline.question('Press ENTER when ready: ', () => {
      readline.close();
      resolve();
    });
  });

  console.log('Continuing with download...\n');
}

async function downloadAllSpreads() {
  // Use persistent context to save login session
  // Use book-specific directory if isolated mode is enabled for parallel downloads
  const userDataDir = ISOLATED
    ? path.join(__dirname, `.browser-data-${BOOK_ID}`)
    : path.join(__dirname, '.browser-data');

  if (ISOLATED) {
    console.log(`Using isolated browser profile for book ${BOOK_ID}`);
  }

  // Clear cache if requested
  if (CLEAR_CACHE) {
    console.log('Clearing browser cache...');
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      console.log('Cache cleared successfully.\n');
    } else {
      console.log('No cache to clear.\n');
    }
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  // Use the default page that comes with persistent context
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  console.log(`Navigating to book: ${BOOK_URL}`);
  await page.goto(BOOK_URL, { waitUntil: 'networkidle' });

  // Wait for page to load
  await page.waitForTimeout(5000);

  // Check if we need to log in by trying to find the print button
  // If print button is available, we're logged in and have access
  const needsLogin = await page.evaluate(() => {
    // Wait a bit more for viewer to initialize
    const printButton = document.querySelector('#print-pdf');
    const hasPrintButton = !!printButton;

    // Check if we're redirected to login or see login elements
    const hasLoginForm = !!document.querySelector('form[action*="login"], input[type="password"]');
    const hasLoginText = document.body.innerText.toLowerCase().includes('inloggen') ||
                        document.body.innerText.toLowerCase().includes('u moet inloggen');

    // If no print button AND (login form OR login text), then we need to login
    return !hasPrintButton && (hasLoginForm || hasLoginText);
  });

  if (needsLogin) {
    console.log('Not logged in. Please log in now...');
    // Wait for user to log in
    await waitForUserLogin(page);

    // Navigate to book again after login
    console.log(`Navigating to book: ${BOOK_URL}`);
    await page.goto(BOOK_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
  } else {
    console.log('Already logged in! Continuing...\n');
  }

  // Verify print button is available
  const hasPrintButton = await page.evaluate(() => {
    return !!document.querySelector('#print-pdf');
  });

  if (!hasPrintButton) {
    console.error('Error: Print button not found. You may not have access to this book.');
    console.error('Please check that you are logged in and have permission to view this book.');
    await context.close();
    process.exit(1);
  }

  // Detect book info from the page
  console.log('Detecting book information...');
  const bookInfo = await page.evaluate(() => {
    // Only get title from document.title if print button is available (we're logged in)
    const printButton = document.querySelector('#print-pdf');
    let title = printButton ? (document.title || null) : null;

    // Try multiple approaches to find total pages
    let totalPages = null;

    // Method 1: Look for Schema.org JSON-LD data (most reliable)
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data.dataFeedElement && data.dataFeedElement[0] && data.dataFeedElement[0].workExample) {
          const workExample = data.dataFeedElement[0].workExample[0];
          if (workExample.numberOfPages) {
            totalPages = String(workExample.numberOfPages);
            break;
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }

    // Method 2: Look for "XXX pagina's" pattern
    if (!totalPages) {
      const paginaMatch = document.body.innerText.match(/(\d+)\s*pagina'?s/i);
      if (paginaMatch) {
        totalPages = paginaMatch[1];
      }
    }

    // Method 3: Look for "X / Y" pattern in body text
    if (!totalPages) {
      const pageMatch = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/);
      if (pageMatch) {
        totalPages = pageMatch[2];
      }
    }

    // Method 4: Wait and check toolbar specifically
    if (!totalPages) {
      const pageInfoElements = document.querySelectorAll('[class*="page"], [aria-label*="page"], div');
      for (const el of pageInfoElements) {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
        const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (match && text.length < 20) {
          totalPages = match[2];
          break;
        }
      }
    }

    return { title, totalPages };
  });

  if (bookInfo.title) {
    BOOK_TITLE = bookInfo.title.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    console.log(`Book title: ${bookInfo.title}`);
  } else {
    BOOK_TITLE = BOOK_ID;
    console.log(`Could not detect title, using book ID: ${BOOK_ID}`);
  }

  if (bookInfo.totalPages) {
    TOTAL_PAGES = parseInt(bookInfo.totalPages, 10);
    console.log(`Detected ${TOTAL_PAGES} total pages`);
  } else {
    console.log('Could not auto-detect total pages.');

    // Ask user to input manually
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    TOTAL_PAGES = await new Promise((resolve) => {
      readline.question('Please enter the total number of pages manually: ', (answer) => {
        readline.close();
        const pages = parseInt(answer, 10);
        if (isNaN(pages) || pages <= 0) {
          console.error('Invalid page count. Exiting.');
          process.exit(1);
        }
        resolve(pages);
      });
    });

    console.log(`Using ${TOTAL_PAGES} pages`);
  }

  // Apply page limit if provided
  if (PAGE_LIMIT) {
    console.log(`Limiting to ${PAGE_LIMIT} pages for testing`);
    TOTAL_PAGES = Math.min(TOTAL_PAGES, PAGE_LIMIT);
  }

  // Now calculate totalSpreads with the detected TOTAL_PAGES
  const totalSpreads = Math.ceil(TOTAL_PAGES / PAGES_PER_SPREAD);
  console.log(`Total spreads needed: ${totalSpreads}`);

  // Check if all spreads already exist
  const missingSpreadIndexes = [];
  let existingSpreadCount = 0;
  for (let i = 0; i < totalSpreads; i++) {
    const spreadIndex = String(i).padStart(3, '0');
    const outputPath = path.join(OUTPUT_DIR, `spread-${spreadIndex}.pdf`);
    if (!fs.existsSync(outputPath)) {
      missingSpreadIndexes.push(i);
    } else {
      existingSpreadCount++;
    }
  }

  if (existingSpreadCount > 0) {
    console.log(`Found ${existingSpreadCount} spreads already downloaded.`);
  }

  if (missingSpreadIndexes.length === 0) {
    console.log('All spreads already downloaded! Skipping to merge...\n');
    await context.close();
    await mergePDFs();
    return;
  }

  console.log(`Need to download ${missingSpreadIndexes.length} spreads\n`);

  for (let i = 0; i < totalSpreads; i++) {
    const pageNum = i * PAGES_PER_SPREAD;
    const spreadIndex = String(i).padStart(3, '0');
    const outputPath = path.join(OUTPUT_DIR, `spread-${spreadIndex}.pdf`);

    // Skip if already downloaded
    if (fs.existsSync(outputPath)) {
      console.log(`[${i + 1}/${totalSpreads}] Spread ${spreadIndex} already exists, skipping...`);
      continue;
    }

    console.log(`[${i + 1}/${totalSpreads}] Processing spread ${spreadIndex} (pages ${pageNum}-${pageNum + 1})...`);

    // Navigate to the page
    await page.goto(`${BOOK_URL}#${pageNum}`);
    await page.waitForTimeout(4000); // Wait for pages to load

    // Set up listener for new page (PDF)
    const pdfPagePromise = context.waitForEvent('page');

    // Click the print button
    try {
      await page.click('#print-pdf');
    } catch (error) {
      console.error(`Error clicking print button: ${error.message}`);
      continue;
    }

    // Wait for PDF page to open
    let pdfPage;
    try {
      pdfPage = await Promise.race([
        pdfPagePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
    } catch (error) {
      console.error(`Timeout waiting for PDF page: ${error.message}`);
      continue;
    }

    await pdfPage.waitForLoadState('load');

    // Get the blob URL
    const blobUrl = pdfPage.url();
    console.log(`  PDF opened at: ${blobUrl}`);

    // Download the blob
    try {
      const pdfData = await pdfPage.evaluate(async (url) => {
        const response = await fetch(url);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        return Array.from(new Uint8Array(arrayBuffer));
      }, blobUrl);

      // Write to file
      fs.writeFileSync(outputPath, Buffer.from(pdfData));
      console.log(`  ✓ Saved to ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB)`);
    } catch (error) {
      console.error(`  Error saving PDF: ${error.message}`);
    }

    // Close the PDF tab
    await pdfPage.close();

    // Small delay between spreads
    await page.waitForTimeout(500);
  }

  console.log(`\n✓ Downloaded ${totalSpreads} spreads!`);
  console.log(`Spreads saved to: ${OUTPUT_DIR}`);

  await context.close();

  // Merge all PDFs
  await mergePDFs();
}

async function mergePDFs() {
  console.log('\nMerging all spreads into single PDF...');

  const outputFilename = `${BOOK_TITLE || BOOK_ID}.pdf`;
  const outputPath = path.join(__dirname, '..', outputFilename);
  const mergedPdf = await PDFDocument.create();

  const totalSpreads = Math.ceil(TOTAL_PAGES / PAGES_PER_SPREAD);

  for (let i = 0; i < totalSpreads; i++) {
    const spreadIndex = String(i).padStart(3, '0');
    const spreadPath = path.join(OUTPUT_DIR, `spread-${spreadIndex}.pdf`);

    if (!fs.existsSync(spreadPath)) {
      console.log(`Warning: Missing ${spreadPath}`);
      continue;
    }

    try {
      const pdfBytes = fs.readFileSync(spreadPath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());

      copiedPages.forEach((page) => {
        mergedPdf.addPage(page);
      });

      if ((i + 1) % 20 === 0) {
        console.log(`  Merged ${i + 1}/${totalSpreads} spreads...`);
      }
    } catch (error) {
      console.error(`  Error merging ${spreadPath}: ${error.message}`);
    }
  }

  console.log('  Saving merged PDF...');
  const mergedPdfBytes = await mergedPdf.save();
  fs.writeFileSync(outputPath, mergedPdfBytes);

  const fileSizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
  console.log(`\n✓ Complete book saved to: ${outputPath}`);
  console.log(`  File size: ${fileSizeMB} MB`);
  console.log(`  Total pages: ${mergedPdf.getPageCount()}`);
}

downloadAllSpreads().catch(console.error);
