const fs = require('fs');
const html = fs.readFileSync('site/index_old.html', 'utf-8');
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
  fs.writeFileSync('site/src/index.css', styleMatch[1].trim());
  console.log('CSS extracted.');
} else {
  console.log('No style tag found.');
}
