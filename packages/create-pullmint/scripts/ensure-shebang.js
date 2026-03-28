const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'dist', 'index.js');
const content = fs.readFileSync(file, 'utf8');

if (!content.startsWith('#!/usr/bin/env node')) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${content}`);
}
