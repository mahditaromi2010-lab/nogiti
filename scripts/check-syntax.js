// Syntax + template compile check for every JS file and EJS view (no extra dependencies).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p, ext);
  return p.endsWith(ext) ? [p] : [];
});
let failed = 0;
for (const file of ['src', 'scripts', 'public/js', 'test'].flatMap(d => walk(path.join(root, d), '.js'))) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (e) { failed++; console.error(`SYNTAX ${path.relative(root, file)}\n${e.stderr}`); }
}
for (const file of walk(path.join(root, 'views'), '.ejs')) {
  try { ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file }); } catch (e) { failed++; console.error(`EJS ${path.relative(root, file)}: ${e.message}`); }
}
if (failed) { console.error(`${failed} file(s) failed.`); process.exit(1); }
console.log('Syntax check passed for all JavaScript files and EJS templates.');
