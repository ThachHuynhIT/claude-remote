const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

function sanitizeFilename(originalName) {
  const base = path.basename(originalName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'file';
}

function createUploadRouter({ uploadsDir, maxBytes = 20 * 1024 * 1024 }) {
  fs.mkdirSync(uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${sanitizeFilename(file.originalname)}`),
  });

  const upload = multer({ storage, limits: { fileSize: maxBytes } });
  const router = express.Router();

  router.post('/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'no file provided' });
      }
      res.json({ path: path.resolve(req.file.path) });
    });
  });

  return router;
}

module.exports = { sanitizeFilename, createUploadRouter };
