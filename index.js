const { v4: uuidv4 } = require('uuid');

// In-memory store: { uuid: { buffer, createdAt } }
const pdfStore = new Map();

// Clean up PDFs older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of pdfStore.entries()) {
    if (entry.createdAt < cutoff) pdfStore.delete(id);
  }
}, 60 * 60 * 1000);

// Store and return URL
app.post('/store-pdf', (req, res) => {
  const { pdf } = req.body; // base64 string
  if (!pdf) return res.status(400).json({ error: 'No PDF provided' });

  const base64Data = pdf.replace(/^data:application\/pdf;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const id = uuidv4();

  pdfStore.set(id, { buffer, createdAt: Date.now() });

  const url = `${process.env.BASE_URL || `http://localhost:${PORT}`}/pdf/${id}`;
  res.json({ success: true, url });
});

// Serve PDF by ID
app.get('/pdf/:id', (req, res) => {
  const entry = pdfStore.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'PDF not found or expired' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
  res.send(entry.buffer);
});