const express = require('express');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const isProduction = process.env.NODE_ENV === 'production';
const puppeteer = isProduction ? require('puppeteer-core') : require('puppeteer');
const chromium = isProduction ? require('@sparticuz/chromium') : null;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Handlebars Helpers ───────────────────────────────────────────────────────
Handlebars.registerHelper('inc', function(index) {
  return index + 1;
});

// ─── In-Memory PDF Store ──────────────────────────────────────────────────────
const pdfStore = new Map();

// Auto-clean PDFs older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of pdfStore.entries()) {
    if (entry.createdAt < cutoff) {
      pdfStore.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ─── Logo Resolver ────────────────────────────────────────────────────────────
async function getLogo(clientSlug) {
  const logosDir = path.join(__dirname, 'logos');
  const extensions = ['png', 'jpg', 'jpeg', 'svg'];

  const candidates = clientSlug
    ? extensions.map(ext => `${clientSlug}.${ext}`)
    : [];
  candidates.push(...extensions.map(ext => `default.${ext}`));

  for (const filename of candidates) {
    const filepath = path.join(logosDir, filename);
    if (fs.existsSync(filepath)) {
      const ext = filename.split('.').pop().toLowerCase();

      if (ext === 'svg') {
        const data = fs.readFileSync(filepath);
        return `data:image/svg+xml;base64,${Buffer.from(data).toString('base64')}`;
      }

      const compressed = await sharp(filepath)
        .resize(280, 96, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75, progressive: true })
        .toBuffer();

      return `data:image/jpeg;base64,${compressed.toString('base64')}`;
    }
  }

  return null;
}

// ─── Generate PDF ─────────────────────────────────────────────────────────────
async function generatePDF(template, client, data) {
  const templatePath = path.join(__dirname, 'templates', `${template}.hbs`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template "${template}" not found`);
  }

  const templateSource = fs.readFileSync(templatePath, 'utf8');
  const compiledTemplate = Handlebars.compile(templateSource);

  const logo = await getLogo(client);
  const enrichedData = { ...data, logo };
  const html = compiledTemplate(enrichedData);

  const browser = await puppeteer.launch(
    isProduction
      ? {
          args: chromium.args,
          executablePath: await chromium.executablePath(),
          headless: true,
        }
      : {
          headless: true,
          args: ['--no-sandbox'],
        }
  );

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com')
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });

  await browser.close();

  return Buffer.from(pdfBuffer);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// 1. Generate PDF → returns base64
app.post('/generate-pdf', async (req, res) => {
  try {
    const { template, client, data } = req.body;
    const pdfBuffer = await generatePDF(template, client, data);
    const base64PDF = pdfBuffer.toString('base64');
    res.json({
      success: true,
      pdf: `data:application/pdf;base64,${base64PDF}`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Generate PDF → store in memory → return public URL
app.post('/generate-and-store', async (req, res) => {
  try {
    const { template, client, data } = req.body;
    const pdfBuffer = await generatePDF(template, client, data);

    const id = uuidv4();
    pdfStore.set(id, { buffer: pdfBuffer, createdAt: Date.now() });

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/pdf/${id}`;

    res.json({ success: true, url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Store existing base64 PDF → return public URL
app.post('/store-pdf', (req, res) => {
  try {
    const { pdf } = req.body;
    if (!pdf) return res.status(400).json({ error: 'No PDF provided' });

    const base64Data = pdf.replace(/^data:application\/pdf;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const id = uuidv4();

    pdfStore.set(id, { buffer, createdAt: Date.now() });

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/pdf/${id}`;

    res.json({ success: true, url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Serve PDF by ID
app.get('/pdf/:id', (req, res) => {
  const entry = pdfStore.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'PDF not found or expired' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
  res.send(entry.buffer);
});

// 5. List available clients
app.get('/clients', (req, res) => {
  const logosDir = path.join(__dirname, 'logos');
  if (!fs.existsSync(logosDir)) return res.json({ clients: [] });

  const files = fs.readdirSync(logosDir);
  const clients = files
    .filter(f => /\.(png|jpg|jpeg|svg)$/i.test(f))
    .map(f => f.replace(/\.[^.]+$/, ''))
    .filter(name => name !== 'default');

  res.json({ clients });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));