#!/usr/bin/env node
/**
 * Generate OG image for mdflow.dev
 *
 * Usage:
 *   node scripts/generate-og-image.mjs
 *   node scripts/generate-og-image.mjs --port 5173
 *   node scripts/generate-og-image.mjs --url https://mdflow.dev
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const urlIndex = args.indexOf('--url');

const port = portIndex !== -1 ? args[portIndex + 1] : '3000';
const externalUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;

async function waitForServer(url, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  let devServer = null;
  let url = externalUrl;

  // If no external URL provided, start a local dev server
  if (!url) {
    url = `http://localhost:${port}`;
    console.log(`Starting dev server on port ${port}...`);

    devServer = spawn('npm', ['run', 'dev', '--', '--port', port], {
      cwd: projectRoot,
      stdio: 'pipe',
      detached: false,
    });

    devServer.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Local:')) {
        console.log('Dev server ready');
      }
    });

    devServer.stderr.on('data', (data) => {
      // Vite outputs to stderr
      const output = data.toString();
      if (output.includes('Local:')) {
        console.log('Dev server ready');
      }
    });

    console.log('Waiting for server to be ready...');
    const ready = await waitForServer(url);
    if (!ready) {
      console.error('Server failed to start');
      process.exit(1);
    }
  }

  try {
    console.log(`Launching browser...`);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // OG image standard size: 1200x630
    await page.setViewport({
      width: 1200,
      height: 630,
      deviceScaleFactor: 1
    });

    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Wait for animations to settle
    await new Promise(r => setTimeout(r, 2000));

    const outputPath = join(projectRoot, 'public', 'og-image.png');
    console.log(`Taking screenshot...`);

    await page.screenshot({
      path: outputPath,
      type: 'png'
    });

    await browser.close();
    console.log(`OG image saved to: ${outputPath}`);

  } finally {
    if (devServer) {
      console.log('Stopping dev server...');
      devServer.kill('SIGTERM');
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
