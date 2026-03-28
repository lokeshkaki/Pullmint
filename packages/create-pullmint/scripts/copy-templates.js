const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'templates');
const dest = path.join(__dirname, '..', 'dist', 'templates');

fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(src)) {
  if (!file.endsWith('.ts')) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}
