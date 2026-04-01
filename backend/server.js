const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const database = require('./database');
const morgan = require('morgan');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    getActiveMenuCategories,
    getActiveMenuSummary,
    publishMenuVersion,
    clearActiveMenu,
    updateActiveMenuItemAvailability
} = require('./lib/menu-store');
const { extractStructuredMenuOcr } = require('./lib/menu-import');
const {
    createOrder,
    createOrderError,
    createOrderPayment,
    clearBillRequestedForTable,
    closeOpenOrderForTable,
    closeOrderById,
    getActiveOrderForTable,
    getClosedOrdersHistorySummary,
    getOrderById,
    getOrderPaymentSummary,
    getOrderSessionForTable,
    listClosedOrdersHistory,
    listOpenOrders,
    listOrders,
    markBillAttendedForTable,
    markBillRequestedForTable,
    markPaymentReceivedForTable,
    normalizeBillPaymentMethodPreference,
    reverseOrderPayment,
    updateOrderStatus
} = require('./lib/orders');
const {
    appendSuborderToActiveOrder,
    listOpenSuborders,
    updateSuborderStatus,
} = require('./lib/order-suborders');
const {
    createTableRequest,
    getTableRequestById,
    listActiveTableRequestsForTable,
    listTableRequests,
    cancelTableRequestForTable,
    resolvePendingTableRequestsForTable,
    resolvePendingTableRequestsForTableByType,
    resolveTableRequest
} = require('./lib/table-requests');
const { listTables, createTable, deleteTable } = require('./lib/tables');
const { issueAdminToken, verifyAdminPassword, verifyAdminToken } = require('./lib/auth');
const { requireAdmin } = require('./middleware/requireAdmin');
const {
    closeRegister,
    getOpenRegister,
    getRegisterSessionById,
    listRegisterSessions,
    openRegister
} = require('./lib/cash-register');
const {
    buildMercadoPagoReturnRedirect,
    createCheckoutForTable,
    extractMercadoPagoExternalReference,
    extractMercadoPagoPaymentId,
    getCheckoutByExternalReference,
    isMercadoPagoConfigured,
    syncMercadoPagoCheckout,
} = require('./lib/mercado-pago');

const backendRoot = __dirname;
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(backendRoot, 'uploads'));
const pythonBin = path.resolve(process.env.PYTHON_BIN || path.join(backendRoot, 'venv', 'bin', 'python3'));
const processMenuScript = path.resolve(process.env.PROCESS_MENU_SCRIPT || path.join(backendRoot, 'process_menu.py'));
const { readVenueSettings, saveVenueSettings } = require('./lib/venue-settings');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
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

function sendSocketAuthError(socket, error) {
    if (error && error.code === 'ADMIN_AUTH_NOT_CONFIGURED') {
        socket.emit('auth_error', { error: error.message, status: 500 });
        return;
    }

    if (error && error.code === 'MISSING_ADMIN_TOKEN') {
        socket.emit('auth_error', { error: 'Admin token required', status: 401 });
        return;
    }

    socket.emit('auth_error', { error: 'Invalid admin token', status: 403 });
}

function verifySocketAdmin(socket, token) {
    const admin = verifyAdminToken(token);
    socket.data.isAdmin = true;
    socket.data.admin = admin;
    return admin;
}

function sendSocketOrderError(socket, error) {
    socket.emit('order_error', {
        error: error.message,
        status: error.status || 500,
        code: error.code || 'UNKNOWN',
        unavailable_items: Array.isArray(error.unavailable_items) ? error.unavailable_items : undefined
    });
}

function tableRoom(tableId) {
    return `table:${tableId}`;
}

function emitOrderCreated(order) {
    io.to('admin_room').emit('new_order', order);
    io.to(tableRoom(order.table_id)).emit('order_confirmed', order);
}

function emitOrderUpdated(order) {
    if (!order) {
        return;
    }

    io.to('admin_room').emit('order_updated', order);
    io.to(tableRoom(order.table_id)).emit('order_updated', order);
}

function emitSuborderCreated(suborder, order = null) {
    if (!suborder) {
        return;
    }

    const payload = {
        suborder,
        order: order || null,
    };

    io.to('admin_room').emit('suborder_created', payload);
    io.to(tableRoom(suborder.table_id)).emit('suborder_created', payload);
}

function emitSuborderUpdated(suborder, order = null) {
    if (!suborder) {
        return;
    }

    const payload = {
        suborder,
        order: order || null,
    };

    io.to('admin_room').emit('suborder_updated', payload);
    io.to(tableRoom(suborder.table_id)).emit('suborder_updated', payload);
}

function emitTableRequestCreated(request) {
    io.to('admin_room').emit('table_request_created', request);
    io.to(tableRoom(request.table_id)).emit('table_request_created', request);
}

function emitTableRequestUpdated(request) {
    io.to('admin_room').emit('table_request_updated', request);
    io.to(tableRoom(request.table_id)).emit('table_request_updated', request);
}

function emitCashRegisterUpdated(session = null) {
    io.to('admin_room').emit('cash_register_updated', session ? { id: session.id, status: session.status } : { status: 'updated' });
}

function sendOrderHttpError(res, error) {
    const status = error.status || 500;
    res.status(status).json({
        error: error.message,
        code: error.code || 'UNKNOWN',
        unavailable_items: Array.isArray(error.unavailable_items) ? error.unavailable_items : undefined,
        amount_due: Number.isFinite(Number(error.amount_due)) ? Number(error.amount_due) : undefined,
        reversible_amount: Number.isFinite(Number(error.reversible_amount)) ? Number(error.reversible_amount) : undefined,
    });
}

function getFrontendHost() {
    return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function getBackendHost() {
    return (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function buildTableUrl(tableId) {
    return `${getFrontendHost()}/${tableId}`;
}

async function buildTableQrImage(tableId, url) {
    const qrSvg = await QRCode.toString(url, {
        type: 'svg',
        width: 360,
        margin: 1,
        errorCorrectionLevel: 'H'
    });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`;
}

async function buildTableQrPayload(table) {
    const tableId = table.id ?? table.table_id;
    const url = buildTableUrl(tableId);
    const qrImage = await buildTableQrImage(tableId, url);

    return {
        id: tableId,
        label: table.label || null,
        created_at: table.created_at || null,
        url,
        qr_image: qrImage
    };
}

app.get('/api/health', async (req, res) => {
    try {
        await database.get('SELECT 1 AS ok');
        res.json({
            status: 'ok',
            database: 'ok'
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            database: 'error',
            error: err.message
        });
    }
});

app.get('/api/venue-settings', async (req, res) => {
    try {
        const settings = await readVenueSettings(database);
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/venue-settings', requireAdmin, async (req, res) => {
    try {
        const settings = await saveVenueSettings(database, req.body);
        io.emit('venue_settings_updated');
        res.json(settings);
    } catch (error) {
        if (error.status === 400) {
            return res.status(400).json({
                error: error.message,
                fields: error.fields || {}
            });
        }

        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/guest-links', async (req, res) => {
    try {
        const settings = await readVenueSettings(database);
        res.json({
            contact_label: settings.contact_label || null,
            contact_url: settings.contact_url || null,
            feedback_url: settings.feedback_url || null,
            review_url: settings.review_url || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/payments/mercado-pago/status', async (req, res) => {
    res.json({
        enabled: isMercadoPagoConfigured(),
        backend_url: getBackendHost(),
    });
});

app.get('/api/admin/cash-register/current', requireAdmin, async (req, res) => {
    try {
        const currentSession = await getOpenRegister(database);
        res.json(currentSession);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

app.post('/api/admin/cash-register/open', requireAdmin, async (req, res) => {
    try {
        const session = await database.withTransaction(async () => openRegister(database, {
            opening_float: req.body?.opening_float,
            notes_open: req.body?.notes_open,
            opened_by: req.admin?.role || null,
        }));
        emitCashRegisterUpdated(session);
        res.status(201).json(session);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

app.post('/api/admin/cash-register/current/close', requireAdmin, async (req, res) => {
    try {
        const session = await database.withTransaction(async () => closeRegister(database, {
            counted_cash_amount: req.body?.counted_cash_amount,
            notes_close: req.body?.notes_close,
            closed_by: req.admin?.role || null,
        }));
        emitCashRegisterUpdated(session);
        res.json(session);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

app.get('/api/admin/cash-register/history', requireAdmin, async (req, res) => {
    try {
        const history = await listRegisterSessions(database, { limit: req.query?.limit });
        res.json(history);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

app.get('/api/admin/cash-register/:id', requireAdmin, async (req, res) => {
    try {
        const session = await getRegisterSessionById(database, req.params.id);

        if (!session) {
            return res.status(404).json({
                error: 'No encontramos esa sesión de caja.',
                code: 'CASH_REGISTER_NOT_FOUND'
            });
        }

        res.json(session);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

app.get('/api/admin/tables', requireAdmin, async (req, res) => {
    try {
        const tables = await listTables(database);
        const payload = await Promise.all(tables.map((table) => buildTableQrPayload(table)));
        res.json(payload);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post('/api/admin/tables', requireAdmin, async (req, res) => {
    try {
        const table = await createTable(database, req.body);
        const payload = await buildTableQrPayload(table);
        res.status(201).json(payload);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.delete('/api/admin/tables/:id', requireAdmin, async (req, res) => {
    try {
        const result = await deleteTable(database, req.params.id);
        res.json({ success: true, deleted_table: result });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};

    try {
        verifyAdminPassword(password);
        const { token, payload } = issueAdminToken();
        res.json({
            token,
            expires_at: payload.exp
        });
    } catch (error) {
        if (error.code === 'ADMIN_AUTH_NOT_CONFIGURED') {
            return res.status(500).json({ error: error.message });
        }

        if (error.code === 'INVALID_ADMIN_CREDENTIALS') {
            return res.status(401).json({ error: error.message });
        }

        return res.status(400).json({ error: error.message });
    }
});

// 1. Get Menu
app.get('/api/menu', async (req, res) => {
    try {
        const menu = await getActiveMenuCategories(database);
        res.json(menu);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.get('/api/menu/active', requireAdmin, async (req, res) => {
    try {
        const menu = await getActiveMenuSummary(database);
        res.json(menu);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// OCR + NLP Upload
app.post('/api/menu/upload', requireAdmin, upload.single('menuImage'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    
    try {
        console.log('Running structured OCR on', req.file.path);
        const ocrPayload = await extractStructuredMenuOcr(req.file.path);
        console.log('OCR lines detected:', ocrPayload.lines.length, 'avg confidence:', ocrPayload.confidence);
        const pythonProcess = spawn(pythonBin, [processMenuScript], { cwd: backendRoot });
        let jsonOutput = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => { jsonOutput += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

        pythonProcess.on('close', (code) => {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            if (code !== 0) {
                console.error('Python Error:', errorOutput);
                return res.status(500).json({ error: 'Menu parse error', details: errorOutput });
            }
            try {
                const result = JSON.parse(jsonOutput);
                if (result && typeof result === 'object') {
                    result.preview_images = (ocrPayload.preprocessing?.preview_images || []);
                    result.diagnostics = {
                        ...(result.diagnostics || {}),
                        ocr_candidates: ocrPayload.preprocessing?.candidates || [],
                    };
                }
                res.json(result);
            } catch (e) {
                console.error("JSON PARSE ERROR", jsonOutput);
                res.status(500).json({ error: 'Invalid NLP JSON', details: jsonOutput });
            }
        });

        pythonProcess.stdin.write(JSON.stringify(ocrPayload));
        pythonProcess.stdin.end();

    } catch (err) {
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("OCR Error", err);
        res.status(500).json({ error: err.message });
    }
});

// Publish Menu
app.post('/api/menu/publish', requireAdmin, async (req, res) => {
    const { categories, name } = req.body;

    if (!Array.isArray(categories)) {
        return res.status(400).json({ error: 'categories must be an array' });
    }

    try {
        const menuId = await publishMenuVersion(database, categories, name);
        io.emit('menu_updated');
        res.json({ success: true, menu_id: menuId });
    } catch (err) {
        console.error('Menu publish failed', err);
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'UNKNOWN'
        });
    }
});

app.delete('/api/menu/active', requireAdmin, async (req, res) => {
    try {
        const clearedMenu = await clearActiveMenu(database);

        if (!clearedMenu) {
            return res.status(404).json({ error: 'No hay un menú publicado para quitar.' });
        }

        io.emit('menu_updated');
        res.json({
            success: true,
            cleared_menu: clearedMenu,
        });
    } catch (error) {
        console.error('Clear active menu failed', error);
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/admin/menu-items/:id/availability', requireAdmin, async (req, res) => {
    try {
        const item = await updateActiveMenuItemAvailability(
            database,
            req.params.id,
            req.body?.is_available
        );

        io.emit('menu_updated');
        res.json(item);
    } catch (error) {
        res.status(error.status || 500).json({
            error: error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

// 2. Generate QR for a table
app.get('/api/tables/:id/qr', async (req, res) => {
    const tableId = req.params.id;
    const url = buildTableUrl(tableId);
    
    try {
        const qrImage = await buildTableQrImage(tableId, url);
        res.json({ tableId, url, qrImage });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.get('/api/tables/:id/orders/active', async (req, res) => {
    try {
        const order = await getActiveOrderForTable(database, req.params.id);
        res.json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/tables/:id/orders/session', async (req, res) => {
    try {
        const session = await getOrderSessionForTable(database, req.params.id);
        res.json(session);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/mercado-pago/checkout', async (req, res) => {
    try {
        const settings = await readVenueSettings(database);
        const checkout = await createCheckoutForTable(
            database,
            req.params.id,
            {
                restaurant_name: settings.restaurant_name,
            }
        );
        res.status(201).json(checkout);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/payments/mercado-pago/webhook', async (req, res) => {
    try {
        const paymentId = extractMercadoPagoPaymentId(req.body, req.query);
        const externalReference = extractMercadoPagoExternalReference(req.body, req.query);
        const result = await syncMercadoPagoCheckout(database, {
            paymentId,
            externalReference,
            eventSource: 'webhook',
        });

        if (result?.applied && result?.order) {
            emitOrderUpdated(result.order);
            emitCashRegisterUpdated();
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Mercado Pago webhook failed', error);
        res.status(200).json({ received: true, ignored: true });
    }
});

app.get('/api/payments/mercado-pago/return', async (req, res) => {
    const paymentId = extractMercadoPagoPaymentId({}, req.query);
    const externalReference = extractMercadoPagoExternalReference({}, req.query);
    const fallbackStatus = String(req.query.result || req.query.status || 'pending').trim().toLowerCase();

    try {
        const result = await syncMercadoPagoCheckout(database, {
            paymentId,
            externalReference,
            eventSource: 'return',
        });
        const order = result?.order || (result?.checkout?.order_id ? await getOrderById(database, result.checkout.order_id) : null);
        const mpStatus = result?.checkout?.status === 'approved' && result?.checkout?.sync_disposition === 'applied'
            ? 'approved'
            : result?.checkout?.status === 'pending'
                && result?.checkout?.sync_disposition === 'pending'
                ? 'pending'
                : ['rejected', 'cancelled', 'expired', 'failed', 'refunded', 'charged_back', 'reversed'].includes(result?.checkout?.status)
                    || ['ignored', 'stale', 'mismatched'].includes(result?.checkout?.sync_disposition)
                    ? 'failure'
                    : fallbackStatus === 'approved'
                        ? 'approved'
                        : fallbackStatus === 'pending'
                            ? 'pending'
                            : 'failure';

        if (result?.applied && order) {
            emitOrderUpdated(order);
            if (result?.checkout?.status === 'approved') {
                emitCashRegisterUpdated();
            }
        }

        if (order) {
            return res.redirect(buildMercadoPagoReturnRedirect(order.table_id, mpStatus));
        }
    } catch (error) {
        console.error('Mercado Pago return sync failed', error);
    }

    return res.redirect(`${getFrontendHost()}?mp_status=${encodeURIComponent(fallbackStatus || 'pending')}`);
});

app.get('/api/tables/:id/requests/active', async (req, res) => {
    try {
        const requests = await listActiveTableRequestsForTable(database, req.params.id);
        res.json(requests);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/call-waiter', async (req, res) => {
    try {
        const tableRequest = await createTableRequest(database, {
            table_id: req.params.id,
            type: 'call_waiter'
        });

        if (!tableRequest.already_pending) {
            emitTableRequestCreated(tableRequest);
            return res.status(201).json(tableRequest);
        }

        res.json(tableRequest);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/request-bill', async (req, res) => {
    try {
        const preferredPaymentMethod = normalizeBillPaymentMethodPreference(
            req.body?.preferred_payment_method,
            { allowNull: false }
        );

        const { tableRequest, resolvedRequests, order } = await database.withTransaction(async () => {
            const nextOrder = await markBillRequestedForTable(database, req.params.id, preferredPaymentMethod);

            if (preferredPaymentMethod === 'mercado_pago') {
                const nextResolvedRequests = await resolvePendingTableRequestsForTableByType(
                    database,
                    req.params.id,
                    'request_bill'
                );

                return {
                    tableRequest: null,
                    resolvedRequests: nextResolvedRequests,
                    order: nextOrder,
                };
            }

            const nextTableRequest = await createTableRequest(database, {
                table_id: req.params.id,
                type: 'request_bill'
            });

            return {
                tableRequest: nextTableRequest,
                resolvedRequests: [],
                order: nextOrder,
            };
        });

        emitOrderUpdated(order);
        resolvedRequests.forEach(emitTableRequestUpdated);

        if (tableRequest && !tableRequest.already_pending) {
            emitTableRequestCreated(tableRequest);
            return res.status(201).json({
                ...(tableRequest || {}),
                table_request: tableRequest,
                resolved_requests: resolvedRequests,
                order,
                preferred_payment_method: order.bill_payment_method_preference,
                should_start_online_checkout: order.bill_payment_method_preference === 'mercado_pago',
            });
        }

        if (tableRequest?.already_pending) {
            emitTableRequestUpdated(tableRequest);
        }

        res.json({
            ...(tableRequest || {}),
            table_request: tableRequest,
            resolved_requests: resolvedRequests,
            order,
            preferred_payment_method: order.bill_payment_method_preference,
            should_start_online_checkout: order.bill_payment_method_preference === 'mercado_pago',
        });
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.delete('/api/tables/:id/call-waiter', async (req, res) => {
    try {
        const tableRequest = await cancelTableRequestForTable(database, {
            table_id: req.params.id,
            type: 'call_waiter'
        });

        emitTableRequestUpdated(tableRequest);
        res.json(tableRequest);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.delete('/api/tables/:id/request-bill', async (req, res) => {
    try {
        const { tableRequest, order } = await database.withTransaction(async () => {
            const currentOrder = await getActiveOrderForTable(database, req.params.id);

            if (!currentOrder) {
                throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para esta mesa.', 404);
            }

            if (currentOrder.bill_attended_at) {
                throw createOrderError(
                    'BILL_ALREADY_ATTENDED',
                    'La cuenta ya fue entregada y no se puede cancelar.',
                    409
                );
            }

            let nextTableRequest = null;

            try {
                nextTableRequest = await cancelTableRequestForTable(database, {
                    table_id: req.params.id,
                    type: 'request_bill'
                });
            } catch (error) {
                if (error.code !== 'TABLE_REQUEST_NOT_FOUND') {
                    throw error;
                }
            }

            const nextOrder = await clearBillRequestedForTable(database, req.params.id);

            return { tableRequest: nextTableRequest, order: nextOrder };
        });

        emitOrderUpdated(order);
        if (tableRequest) {
            emitTableRequestUpdated(tableRequest);
        }
        const fallbackTableRequest = tableRequest || {
                id: null,
                table_id: Number(req.params.id),
                type: 'request_bill',
                status: 'resolved',
                resolved_at: new Date().toISOString(),
                already_resolved: true
            };

        res.json({
            ...fallbackTableRequest,
            table_request: fallbackTableRequest,
            order,
        });
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/orders', async (req, res) => {
    try {
        const order = await createOrder(database, req.body);
        emitOrderCreated(order);
        res.status(201).json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/suborders', async (req, res) => {
    try {
        const { order, suborder } = await database.withTransaction(async () => {
            const nextSuborder = await appendSuborderToActiveOrder(database, req.params.id, req.body || {});
            const nextOrder = await getOrderById(database, nextSuborder.order_id);
            return { order: nextOrder, suborder: nextSuborder };
        });

        emitSuborderCreated(suborder, order);
        emitOrderUpdated(order);
        res.status(201).json({ order, suborder });
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/admin/orders/history', requireAdmin, async (req, res) => {
    try {
        const history = await listClosedOrdersHistory(database, req.query || {});
        res.json(history);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/admin/orders/history/summary', requireAdmin, async (req, res) => {
    try {
        const summary = await getClosedOrdersHistorySummary(database, req.query || {});
        res.json(summary);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/admin/orders/open', requireAdmin, async (req, res) => {
    try {
        const orders = await listOpenOrders(database);
        res.json(orders);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/admin/suborders/open', requireAdmin, async (req, res) => {
    try {
        const suborders = await listOpenSuborders(database);
        const uniqueOrderIds = [...new Set(suborders.map((suborder) => suborder.order_id).filter(Boolean))];
        const ordersById = new Map();

        await Promise.all(uniqueOrderIds.map(async (orderId) => {
            const order = await getOrderById(database, orderId);
            if (order) {
                ordersById.set(orderId, order);
            }
        }));

        const payload = suborders.map((suborder) => {
            const order = ordersById.get(suborder.order_id) || null;

            return {
                ...suborder,
                session_total_amount: order?.total_amount || 0,
                session_amount_paid: order?.amount_paid || 0,
                session_amount_due: order?.amount_due || 0,
                session_payment_status: order?.payment_status || 'unpaid',
                bill_requested_at: order?.bill_requested_at || suborder.bill_requested_at || null,
                bill_payment_method_preference: order?.bill_payment_method_preference || null,
                order_status: order?.status || null,
            };
        });

        res.json(payload);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/admin/suborders/:id/status', requireAdmin, async (req, res) => {
    try {
        const { suborder, order } = await database.withTransaction(async () => {
            const nextSuborder = await updateSuborderStatus(database, req.params.id, req.body?.status);
            const nextOrder = await getOrderById(database, nextSuborder.order_id);
            return { suborder: nextSuborder, order: nextOrder };
        });

        emitSuborderUpdated(suborder, order);
        emitOrderUpdated(order);
        res.json({ suborder, order });
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.get('/api/admin/orders/:id/payments', requireAdmin, async (req, res) => {
    try {
        const paymentSummary = await getOrderPaymentSummary(database, req.params.id);
        res.json(paymentSummary);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/admin/orders/:id/payments', requireAdmin, async (req, res) => {
    try {
        const order = await database.withTransaction(async () => createOrderPayment(
            database,
            req.params.id,
            {
                amount: req.body?.amount,
                method: req.body?.method,
                note: req.body?.note,
            },
            {
                created_by: req.admin?.role || null,
            }
        ));

        emitOrderUpdated(order);
        emitCashRegisterUpdated();
        res.status(201).json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/admin/orders/:orderId/payments/:paymentId/reversals', requireAdmin, async (req, res) => {
    try {
        const order = await database.withTransaction(async () => reverseOrderPayment(
            database,
            req.params.orderId,
            req.params.paymentId,
            {
                amount: req.body?.amount,
                reason: req.body?.reason,
            },
            {
                created_by: req.admin?.role || null,
            }
        ));

        emitOrderUpdated(order);
        emitCashRegisterUpdated();
        res.status(201).json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/admin/orders/:id/close', requireAdmin, async (req, res) => {
    try {
        const { order, resolvedRequests } = await database.withTransaction(async () => {
            const nextOrder = await closeOrderById(database, req.params.id);
            const nextResolvedRequests = await resolvePendingTableRequestsForTable(database, nextOrder.table_id);
            return { order: nextOrder, resolvedRequests: nextResolvedRequests };
        });

        resolvedRequests.forEach(emitTableRequestUpdated);
        emitOrderUpdated(order);
        res.json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

// 3. Get all orders (for admin initial load)
app.get('/api/orders', requireAdmin, async (req, res) => {
    try {
        const orders = await listOrders(database);
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/table-requests', requireAdmin, async (req, res) => {
    try {
        const tableRequests = await listTableRequests(database);
        res.json(tableRequests);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/table-requests/:id/resolve', requireAdmin, async (req, res) => {
    try {
        const { tableRequest, order } = await database.withTransaction(async () => {
            const nextTableRequest = await resolveTableRequest(database, req.params.id);
            const nextOrder = nextTableRequest.type === 'request_bill'
                ? await markBillAttendedForTable(database, nextTableRequest.table_id)
                : null;
            const refreshedTableRequest = nextTableRequest.type === 'request_bill'
                ? await getTableRequestById(database, nextTableRequest.id)
                : nextTableRequest;

            return { tableRequest: refreshedTableRequest, order: nextOrder };
        });

        emitOrderUpdated(order);
        emitTableRequestUpdated(tableRequest);
        res.json(tableRequest);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/close', requireAdmin, async (req, res) => {
    try {
        const { order, resolvedRequests } = await database.withTransaction(async () => {
            const nextOrder = await closeOpenOrderForTable(database, req.params.id);
            const nextResolvedRequests = await resolvePendingTableRequestsForTable(database, req.params.id);
            return { order: nextOrder, resolvedRequests: nextResolvedRequests };
        });

        resolvedRequests.forEach(emitTableRequestUpdated);
        emitOrderUpdated(order);
        res.json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

app.post('/api/tables/:id/payment', requireAdmin, async (req, res) => {
    try {
        const order = await database.withTransaction(async () => {
            const nextOrder = await markPaymentReceivedForTable(
                database,
                req.params.id,
                req.body?.payment_method,
                {
                    note: req.body?.note,
                    created_by: req.admin?.role || null,
                }
            );
            return nextOrder;
        });

        emitOrderUpdated(order);
        emitCashRegisterUpdated();
        res.json(order);
    } catch (error) {
        sendOrderHttpError(res, error);
    }
});

// Socket.io for Real-time
io.on('connection', (socket) => {
    console.log('New client connected', socket.id);
    socket.data.isAdmin = false;
    socket.data.tableRoom = null;
    
    socket.on('join_admin', (data = {}) => {
        try {
            verifySocketAdmin(socket, data.token);
        } catch (error) {
            socket.data.isAdmin = false;
            return sendSocketAuthError(socket, error);
        }

        socket.join('admin_room');
        console.log(`Socket ${socket.id} joined admin room`);
        socket.emit('admin_joined', { success: true });
    });

    socket.on('join_table', (data = {}, callback) => {
        const tableId = Number(data.table_id);

        if (!Number.isInteger(tableId) || tableId <= 0) {
            if (typeof callback === 'function') {
                callback({ success: false, error: 'table_id must be a positive integer' });
            }
            return;
        }

        if (socket.data.tableRoom) {
            socket.leave(socket.data.tableRoom);
        }

        socket.data.tableRoom = tableRoom(tableId);
        socket.data.tableId = tableId;
        socket.join(socket.data.tableRoom);

        if (typeof callback === 'function') {
            callback({ success: true, table_id: tableId });
        }
    });

    socket.on('place_order', async (data = {}) => {
        try {
            const order = await createOrder(database, data);
            emitOrderCreated(order);
        } catch (error) {
            sendSocketOrderError(socket, error);
        }
    });

    socket.on('update_order_status', async (data = {}) => {
        try {
            verifySocketAdmin(socket, data.token);
        } catch (error) {
            socket.data.isAdmin = false;
            return sendSocketAuthError(socket, error);
        }

        try {
            const result = await updateOrderStatus(database, data.order_id, data.status);
            if (result?.suborder) {
                emitSuborderUpdated(result.suborder, result.order || null);
            }
            emitOrderUpdated(result?.order || result);
        } catch (error) {
            sendSocketOrderError(socket, error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
database.initializeDatabase()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Database initialization failed', error);
        process.exit(1);
    });
