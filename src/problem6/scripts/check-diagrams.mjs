// Renders every ```mermaid block in the repository's Markdown files and fails on the first syntax error,
// so a broken diagram never reaches the spec's readers. Uses one headless browser for all diagrams.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderMermaid } from '@mermaid-js/mermaid-cli';
import puppeteer from 'puppeteer';

const root = new URL('..', import.meta.url).pathname;

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith('.md')) yield path;
  }
}

const diagrams = [];
for (const file of markdownFiles(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```mermaid') continue;
    const start = i + 1;
    while (++i < lines.length && lines[i].trim() !== '```');
    diagrams.push({ where: `${relative(root, file)}:${start}`, definition: lines.slice(start, i).join('\n') });
  }
}

// GitHub-hosted Ubuntu runners block Chrome's sandbox (AppArmor), so CI disables it.
const browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });
let failures = 0;
try {
  for (const { where, definition } of diagrams) {
    try {
      await renderMermaid(browser, definition, 'svg');
      console.log(`✓ ${where}`);
    } catch (error) {
      failures++;
      console.error(`✗ ${where}\n  ${String(error.message ?? error).split('\n').slice(0, 4).join('\n  ')}`);
    }
  }
} finally {
  await browser.close();
}

console.log(`\n${diagrams.length - failures}/${diagrams.length} diagrams render`);
if (failures > 0 || diagrams.length === 0) process.exit(1);
