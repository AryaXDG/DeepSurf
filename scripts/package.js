/**
 * @fileoverview Build post-processor packaging DeepSurf compiles into release formats.
 *
 * This node script checks the build directory and packages files into a ZIP archive 
 * for Chrome Web Store distribution.
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const sourceDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'releases');

if (!fs.existsSync(sourceDir)) {
  console.error(`Build folder ${sourceDir} not found. Run the build step first.`);
  process.exit(1);
}

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

console.log(`Packaging DeepSurf for Chrome...`);

const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const outPath = path.join(outDir, `deepsurf-chrome-v${packageJson.version}.zip`);
const zip = new AdmZip();
zip.addLocalFolder(sourceDir);
zip.writeZip(outPath);
console.log(`Success! Created ${outPath}`);