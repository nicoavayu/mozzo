const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const db = require('./database');
const morgan = require('morgan');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_VENUE_SETTINGS = Object.freeze({
  restaurant_name: 'Mozzo',
  restaurant_subtitle: '',
  contact_label: '',
  contact_url: '',
  review_url: '',
  feedback_url: '',
  updated_at: null
});

function runDbStatement(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function statementCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function getDbRow(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function normalizeOptionalUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function normalizeVenueSettingsInput(input = {}) {
  return {
    restaurant_name: String(input.restaurant_name || '').trim(),
    restaurant_subtitle: String(input.restaurant_subtitle || '').trim(),
    contact_label: String(input.contact_label || '').trim(),
    contact_url: normalizeOptionalUrl(input.contact_url),
    review_url: normalizeOptionalUrl(input.review_url),
    feedback_url: normalizeOptionalUrl(input.feedback_url)
  };
}

function validateVenueSettingsInput(input) {
  const errors = {};
  if (!input.restaurant_name) {
    errors.restaurant_name = 'El nombre del local es obligatorio.';
  }

  if ((input.contact_label && !input.contact_url) || (!input.contact_label && input.contact_url)) {
    errors.contact = 'Completá etiqueta y URL de contacto, o dejá ambos vacíos.';
  }

  ['contact_url', 'review_url', 'feedback_url'].forEach((field) => {
    if (input[field] && !isValidHttpUrl(input[field])) {
      errors[field] = 'Ingresá una URL válida con http o https.';
    }
  });

  return errors;
}

function mergeVenueSettings(row) {
  if (!row) {
    return { ...DEFAULT_VENUE_SETTINGS };
  }

  return {
    restaurant_name: row.restaurant_name || DEFAULT_VENUE_SETTINGS.restaurant_name,
    restaurant_subtitle: row.restaurant_subtitle || '',
    contact_label: row.contact_label || '',
    contact_url: row.contact_url || '',
    review_url: row.review_url || '',
    feedback_url: row.feedback_url || '',
    updated_at: row.updated_at || null
  };
}

async function readVenueSettings() {
  const row = await getDbRow(
    `SELECT restaurant_name, restaurant_subtitle, contact_label, contact_url, review_url, feedback_url, updated_at
     FROM venue_settings
     WHERE id = 1`
  );

  return mergeVenueSettings(row);
}

async function saveVenueSettings(input) {
  const normalized = normalizeVenueSettingsInput(input);
  const errors = validateVenueSettingsInput(normalized);

  if (Object.keys(errors).length > 0) {
    const error = new Error('Invalid venue settings');
    error.statusCode = 400;
    error.fields = errors;
    throw error;
  }

  await runDbStatement(
    `INSERT INTO venue_settings (
      id,
      restaurant_name,
      restaurant_subtitle,
      contact_label,
      contact_url,
      review_url,
      feedback_url,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      restaurant_name = excluded.restaurant_name,
      restaurant_subtitle = excluded.restaurant_subtitle,
      contact_label = excluded.contact_label,
      contact_url = excluded.contact_url,
      review_url = excluded.review_url,
      feedback_url = excluded.feedback_url,
      updated_at = CURRENT_TIMESTAMP`,
    [
      normalized.restaurant_name,
      normalized.restaurant_subtitle,
      normalized.contact_label,
      normalized.contact_url,
      normalized.review_url,
      normalized.feedback_url
    ]
  );

  return readVenueSettings();
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync('uploads/')) fs.mkdirSync('uploads/');
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const ext = file.originalname ? file.originalname.split('.').pop() : 'png';
    cb(null, file.fieldname + '-' + Date.now() + '.' + ext);
  }
});
const upload = multer({ storage: storage });

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/venue-settings', async (_req, res) => {
  try {
    const settings = await readVenueSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/venue-settings', async (req, res) => {
  try {
    const settings = await saveVenueSettings(req.body);
    io.emit('venue_settings_updated');
    res.json(settings);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? 'Configuración inválida.'
        : error.code === 'SQLITE_READONLY'
          ? 'La base de datos actual quedó en modo solo lectura. Reiniciá el backend para volver a guardar.'
          : error.message,
      fields: error.fields || undefined
    });
  }
});

// 1. Get Menu
app.get('/api/menu', (req, res) => {
    db.all("SELECT * FROM menu_categories", [], (err, categories) => {
        if (err) return res.status(500).json({error: err.message});
        
        db.all("SELECT * FROM menu_items", [], (err, items) => {
             if (err) return res.status(500).json({error: err.message});
             
             // Group by category
             const menu = categories.map(cat => ({
                 ...cat,
                 items: items.filter(item => item.category_id === cat.id)
             }));
             res.json(menu);
        });
    });
});

// OCR + NLP Upload
app.post('/api/menu/upload', upload.single('menuImage'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    
    try {
        console.log('Running OCR on', req.file.path);
        const { data: { text } } = await Tesseract.recognize(req.file.path, 'spa');
        
        console.log('OCR Result len:', text.length);
        const pythonProcess = spawn('./venv/bin/python3', ['./process_menu.py']);
        let jsonOutput = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => { jsonOutput += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

        pythonProcess.on('close', (code) => {
            fs.unlinkSync(req.file.path);
            if (code !== 0) {
                console.error('Python Error:', errorOutput);
                return res.status(500).json({ error: 'NLP Error', details: errorOutput });
            }
            try {
                const result = JSON.parse(jsonOutput);
                res.json(result);
            } catch (e) {
                console.error("JSON PARSE ERROR", jsonOutput);
                res.status(500).json({ error: 'Invalid NLP JSON', details: jsonOutput });
            }
        });

        pythonProcess.stdin.write(text);
        pythonProcess.stdin.end();

    } catch (err) {
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("OCR Error", err);
        res.status(500).json({ error: err.message });
    }
});

// Publish Menu
app.post('/api/menu/publish', (req, res) => {
    const { categories } = req.body;
    db.serialize(() => {
        db.run('DELETE FROM order_items');
        db.run('DELETE FROM orders');
        db.run('DELETE FROM menu_items');
        db.run('DELETE FROM menu_categories');
        
        if(!categories || categories.length === 0) return res.json({ success: true });
        
        let catsInserted = 0;
        categories.forEach(cat => {
            db.run('INSERT INTO menu_categories (name) VALUES (?)', [cat.name], function(err) {
                if (err) return console.error(err);
                const catId = this.lastID;
                
                cat.items.forEach(item => {
                    db.run('INSERT INTO menu_items (category_id, name, description, price) VALUES (?, ?, ?, ?)',
                        [catId, item.name, item.description || '', item.price || 0.0]);
                });
                
                catsInserted++;
                if (catsInserted === categories.length) {
                     // Notify clients to refresh
                    io.emit('menu_updated');
                    res.json({ success: true });
                }
            });
        });
    });
});

// 2. Generate QR for a table
app.get('/api/tables/:id/qr', async (req, res) => {
    const tableId = req.params.id;
    const frontendHost = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = `${frontendHost}/${tableId}`;
    
    try {
        const qrImage = await QRCode.toDataURL(url);
        res.json({ tableId, url, qrImage });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// 3. Get all orders (for admin initial load)
app.get('/api/orders', (req, res) => {
    const query = `
        SELECT o.id, o.table_id, o.status, o.created_at, 
               oi.item_id, oi.quantity, oi.comments, 
               m.name as item_name, m.price
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN menu_items m ON oi.item_id = m.id
        ORDER BY o.created_at DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        
        const orders = {};
        rows.forEach(row => {
            if (!orders[row.id]) {
                orders[row.id] = {
                    id: row.id,
                    table_id: row.table_id,
                    status: row.status,
                    created_at: row.created_at,
                    items: []
                };
            }
            orders[row.id].items.push({
                item_id: row.item_id,
                name: row.item_name,
                price: row.price,
                quantity: row.quantity,
                comments: row.comments
            });
        });
        res.json(Object.values(orders));
    });
});

// Socket.io for Real-time
io.on('connection', (socket) => {
    console.log('New client connected', socket.id);
    
    socket.on('join_admin', () => {
        socket.join('admin_room');
        console.log(`Socket ${socket.id} joined admin room`);
    });

    socket.on('place_order', (data) => {
        // data: { table_id: 1, items: [{id: 1, name: '...', price: 10, quantity: 2, comments: 'no onion'}] }
        const { table_id, items } = data;
        
        db.run(`INSERT INTO orders (table_id) VALUES (?)`, [table_id], function(err) {
            if (err) return console.error(err.message);
            
            const orderId = this.lastID;
            items.forEach(item => {
                db.run(`INSERT INTO order_items (order_id, item_id, quantity, comments) VALUES (?, ?, ?, ?)`, 
                    [orderId, item.id, item.quantity, item.comments]);
            });
            
            const newOrder = {
                id: orderId,
                table_id,
                status: 'pending',
                created_at: new Date(),
                items: items
            };
            io.to('admin_room').emit('new_order', newOrder);
            
            socket.emit('order_confirmed', newOrder);
        });
    });

    socket.on('update_order_status', (data) => {
        const { order_id, status } = data;
        db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, order_id], function(err) {
            if (err) return console.error(err.message);
            io.to('admin_room').emit('order_status_updated', { order_id, status });
        });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
