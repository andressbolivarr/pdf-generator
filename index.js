const express = require('express');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const isProduction = process.env.NODE_ENV === 'production';
const puppeteer = isProduction ? require('puppeteer-core') : require('puppeteer');
const chromium = isProduction ? require('@sparticuz/chromium') : null;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Handlebars Helpers ───────────────────────────────────────────────────────
Handlebars.registerHelper('inc', function (index) {
  return index + 1;
});

// ─── In-Memory PDF Store ──────────────────────────────────────────────────────
const pdfStore = new Map();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of pdfStore.entries()) {
    if (entry.createdAt < cutoff) pdfStore.delete(id);
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

      if (ext === 'png') {
        const processed = await sharp(filepath)
          .resize(280, 96, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        return `data:image/png;base64,${processed.toString('base64')}`;
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

// ─── Signature Fetcher ────────────────────────────────────────────────────────
async function fetchSignature(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.error('Failed to fetch signature:', error.message);
    return null;
  }
}

// ─── PDF Generator ────────────────────────────────────────────────────────────
async function generatePDF(template, client, data) {
  // Normalize line_items: convert plain strings to {name, serial} objects
  if (data.line_items && Array.isArray(data.line_items)) {
    data.line_items = data.line_items.map(item =>
      typeof item === 'string' ? { name: item, serial: null } : item
    );
  }

  // Fetch signature from URL and convert to base64 data URI
  if (data.signature && data.signature.startsWith('http')) {
    data.signature = await fetchSignature(data.signature);
  }

  const templatePath = path.join(__dirname, 'templates', `${template}.hbs`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template "${template}" not found`);
  }

  const templateSource = fs.readFileSync(templatePath, 'utf8');
  const compiledTemplate = Handlebars.compile(templateSource);
  const logo = await getLogo(client);
  const html = compiledTemplate({ ...data, logo });

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
  page.on('request', req => {
    const url = req.url();
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
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

// ─── HubSpot Uploader ─────────────────────────────────────────────────────────
async function uploadToHubSpot(pdfBuffer, fileName, folderId, token) {
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });
  form.append('folderId', String(folderId));
  form.append(
    'options',
    JSON.stringify({
      access: 'PUBLIC_INDEXABLE',
      ttl: 'P3M',
      overwrite: false,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'ENTIRE_PORTAL',
    })
  );

  const response = await axios.post('https://api.hubapi.com/files/v3/files', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
  });

  return response.data;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// 1. Generate PDF → store in memory → return public URL
app.post('/generate-pdf', async (req, res) => {
  try {
    const { template, client, data } = req.body;
    const pdfBuffer = await generatePDF(template, client, data);
    const id = uuidv4();
    pdfStore.set(id, { buffer: pdfBuffer, createdAt: Date.now() });
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({ success: true, pdfUrl: `${baseUrl}/pdf/${id}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Generate PDF → upload directly to HubSpot → return file ID + URL
app.post('/generate-and-upload-hubspot', async (req, res) => {
  try {
    const { template, client, data, fileName } = req.body;
    const token = process.env.HUBSPOT_TOKEN;
    const folderId = process.env.HUBSPOT_FOLDER_ID || '333969056249';

    if (!token) {
      return res.status(500).json({ success: false, error: 'HUBSPOT_TOKEN env var not set' });
    }

    const pdfBuffer = await generatePDF(template, client, data);
    const resolvedName = fileName || `document-${Date.now()}.pdf`;
    const hubspotFile = await uploadToHubSpot(pdfBuffer, resolvedName, folderId, token);

    res.json({
      success: true,
      fileId: hubspotFile.id,
      fileUrl: hubspotFile.url,
      fileName: hubspotFile.name,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Generate PDF → store in memory → return public URL (legacy alias)
app.post('/generate-and-store', async (req, res) => {
  try {
    const { template, client, data } = req.body;
    const pdfBuffer = await generatePDF(template, client, data);
    const id = uuidv4();
    pdfStore.set(id, { buffer: pdfBuffer, createdAt: Date.now() });
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({ success: true, url: `${baseUrl}/pdf/${id}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Store existing base64 PDF → return public URL
app.post('/store-pdf', (req, res) => {
  try {
    const { pdf } = req.body;
    if (!pdf) return res.status(400).json({ error: 'No PDF provided' });
    const base64Data = pdf.replace(/^data:application\/pdf;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const id = uuidv4();
    pdfStore.set(id, { buffer, createdAt: Date.now() });
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({ success: true, url: `${baseUrl}/pdf/${id}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Serve stored PDF by ID
app.get('/pdf/:id', (req, res) => {
  const entry = pdfStore.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'PDF not found or expired' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
  res.setHeader('Content-Length', entry.buffer.length);
  res.send(entry.buffer);
});

// 6. List available clients
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