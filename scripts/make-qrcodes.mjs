// Generate scannable QR codes for Gantner GC7 bring-up / testing.
//
//   node scripts/make-qrcodes.mjs
//   node scripts/make-qrcodes.mjs MEMBER001 MEMBER002      # custom payloads
//
// Output: out/qr/<value>.png  + out/qr/index.html (printable sheet).
//
// The QR ENCODES exactly the string the reader will emit on the wire. The
// Newland FM3080 reads the QR and sends `STX + <ascii> + ETX` over RS232; the
// controller's app then treats `<ascii>` as the "barcode". So whatever you put
// here is exactly what your backend / permission list must match.
//
// Defaults = the backend's temporary allow-list (src/gantner.ts ALLOWED_IDENTIFIERS).
import QRCode from 'qrcode';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const values = process.argv.slice(2);
if (values.length === 0) values.push('TEST123456', 'HELLO_WORLD', '12345678');

const outDir = join(process.cwd(), 'out', 'qr');
await mkdir(outDir, { recursive: true });

const opts = {
  errorCorrectionLevel: 'M', // good balance for screen + print
  margin: 2,
  width: 512,
  color: { dark: '#000000', light: '#ffffff' },
};

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const made = [];

for (const value of values) {
  const file = join(outDir, `${safe(value)}.png`);
  await QRCode.toFile(file, value, opts);
  const dataUrl = await QRCode.toDataURL(value, opts);
  made.push({ value, file, dataUrl });
  console.log(`  ${value.padEnd(16)} -> ${file}`);
}

const cards = made
  .map(
    (m) => `    <figure>
      <img src="${m.dataUrl}" width="260" height="260" alt="${m.value}" />
      <figcaption><code>${m.value}</code></figcaption>
    </figure>`,
  )
  .join('\n');

const html = `<!doctype html>
<meta charset="utf-8" />
<title>Gantner GC7 test QR codes</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; }
  h1 { font-size: 18px; }
  .grid { display: flex; flex-wrap: wrap; gap: 28px; }
  figure { margin: 0; text-align: center; border: 1px solid #ddd; padding: 12px; border-radius: 8px; }
  figcaption { margin-top: 8px; font-size: 14px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
  p { color: #555; max-width: 640px; }
</style>
<h1>Gantner GC7 &mdash; test QR codes</h1>
<p>Each QR encodes the raw string under it. Scan at a reader; the value travels to
the controller as the &ldquo;barcode&rdquo;. For the gate to open, that exact string
must be authorized (backend allow-list, or a credential provisioned in Gantner).</p>
<div class="grid">
${cards}
</div>`;

await writeFile(join(outDir, 'index.html'), html, 'utf8');
console.log(`\nPrintable sheet -> ${join(outDir, 'index.html')}`);
