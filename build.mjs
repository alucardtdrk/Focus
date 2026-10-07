import { mkdirSync, copyFileSync, cpSync } from 'node:fs';

mkdirSync('dist/src', { recursive: true });
copyFileSync('index.html', 'dist/index.html');
for (const file of ['app.js', 'styles.css', 'supabase.js', 'supabase-config.js', 'theme.js']) {
  copyFileSync(`src/${file}`, `dist/src/${file}`);
}
cpSync('public', 'dist/public', { recursive: true });
console.log('Arquivos públicos preparados em dist.');
