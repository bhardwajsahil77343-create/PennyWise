const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const host = '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const frontendDirectory = path.resolve(__dirname, '..', 'frontend');
const dataFile = path.resolve(process.env.PENNYWISE_DATA_FILE || path.join(__dirname, 'data.json'));
const maximumBodySize = 64 * 1024;
const allowedCategories = new Set([
    'Food & Dining',
    'Bills & EMI',
    'Subscriptions',
    'Shopping',
    'Transport',
    'Other'
]);
const allowedMethods = new Set(['UPI', 'Card', 'Auto-debit', 'Bills & EMI']);
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function daysFromToday(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localDateKey(date);
}

function createInitialData() {
    const today = localDateKey(new Date());
    return {
        balance: 5000,
        transactions: [
            { id: 'seed-netflix', merchant: 'Netflix Subscription', amount: 649, category: 'Subscriptions', method: 'Auto-debit', date: daysFromToday(-1) },
            { id: 'seed-zomato', merchant: 'Zomato Food Delivery', amount: 420, category: 'Food & Dining', method: 'UPI', date: today },
            { id: 'seed-electricity', merchant: 'Electricity Bill', amount: 1850, category: 'Bills & EMI', method: 'Card', date: today }
        ],
        bills: [
            { id: 'car-emi', name: 'HDFC Car EMI', amount: 6999, dueDate: daysFromToday(3), paid: false },
            { id: 'youtube', name: 'YouTube Premium', amount: 139, dueDate: daysFromToday(12), dueIn: 12, paid: false },
            { id: 'prime', name: 'Amazon Prime', amount: 1499, dueDate: daysFromToday(28), dueIn: 28, paid: false }
        ],
        trials: [
            { id: 'trial-spotify', name: 'Spotify', amount: 119, expiresOn: daysFromToday(2) }
        ],
        dismissedSubscriptions: []
    };
}

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
    sendJson(response, statusCode, { error: message });
}

function parseAmount(value, label = 'Amount') {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) {
        throw new HttpError(400, `${label} must be a valid non-negative number.`);
    }
    return amount;
}

function validateDate(value, label, { allowPast = false } = {}) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, `${label} must be a valid YYYY-MM-DD date.`);
    }
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime()) || localDateKey(date) !== value) {
        throw new HttpError(400, `${label} must be a valid calendar date.`);
    }
    if (!allowPast && value < localDateKey(new Date())) {
        throw new HttpError(400, `${label} cannot be in the past.`);
    }
    return value;
}

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maximumBodySize) {
            throw new HttpError(413, 'Request body is too large.');
        }
        chunks.push(chunk);
    }
    if (!size) throw new HttpError(400, 'A JSON request body is required.');
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('Expected a JSON object.');
        }
        return body;
    } catch {
        throw new HttpError(400, 'Request body must contain valid JSON.');
    }
}

function requiredText(value, label, maximumLength = 60) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
        throw new HttpError(400, `${label} is required and must be at most ${maximumLength} characters.`);
    }
    return value.trim();
}

function addDaysToDate(dateKey, days) {
    const date = new Date(`${dateKey}T00:00:00`);
    date.setDate(date.getDate() + days);
    return localDateKey(date);
}

let state;
let mutationQueue = Promise.resolve();

async function saveState(nextState) {
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, dataFile);
}

async function mutateState(mutation) {
    const operation = mutationQueue.then(async () => {
        const nextState = structuredClone(state);
        const result = mutation(nextState);
        await saveState(nextState);
        state = nextState;
        return result;
    });
    mutationQueue = operation.catch(() => {});
    return operation;
}

async function initializeState() {
    try {
        const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));
        if (!saved || typeof saved !== 'object' || !Array.isArray(saved.transactions) || !Array.isArray(saved.bills) || !Array.isArray(saved.trials)) {
            throw new Error('Persistent data file has an invalid format.');
        }
        state = {
            ...createInitialData(),
            ...saved,
            dismissedSubscriptions: Array.isArray(saved.dismissedSubscriptions) ? saved.dismissedSubscriptions : []
        };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = createInitialData();
        await saveState(state);
    }
}

async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/data') {
        sendJson(response, 200, state);
        return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/balance') {
        const body = await readJson(request);
        const balance = parseAmount(body.balance, 'Balance');
        await mutateState((next) => { next.balance = balance; });
        sendJson(response, 200, { balance });
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/transactions') {
        const body = await readJson(request);
        const merchant = requiredText(body.merchant, 'Merchant');
        const amount = parseAmount(body.amount, 'Amount');
        if (amount <= 0) throw new HttpError(400, 'Amount must be greater than zero.');
        if (!allowedCategories.has(body.category)) throw new HttpError(400, 'Choose a supported expense category.');
        if (!allowedMethods.has(body.method)) throw new HttpError(400, 'Choose a supported payment method.');
        const transaction = {
            id: randomUUID(),
            merchant,
            amount,
            category: body.category,
            method: body.method,
            date: validateDate(body.date || localDateKey(new Date()), 'Transaction date')
        };
        await mutateState((next) => { next.transactions.push(transaction); });
        sendJson(response, 201, transaction);
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/bills') {
        const body = await readJson(request);
        const bill = {
            id: randomUUID(),
            name: requiredText(body.name, 'Payment name'),
            amount: parseAmount(body.amount, 'Amount'),
            dueDate: validateDate(body.dueDate, 'Due date'),
            paid: false
        };
        if (bill.amount <= 0) throw new HttpError(400, 'Amount must be greater than zero.');
        await mutateState((next) => { next.bills.push(bill); });
        sendJson(response, 201, bill);
        return;
    }
    const paidMatch = url.pathname.match(/^\/api\/bills\/([a-z0-9_-]+)\/paid$/i);
    if (request.method === 'PATCH' && paidMatch) {
        const body = await readJson(request);
        if (typeof body.paid !== 'boolean') throw new HttpError(400, 'Paid must be true or false.');
        const bill = await mutateState((next) => {
            const item = next.bills.find((entry) => entry.id === paidMatch[1]);
            if (!item) throw new HttpError(404, 'Payment was not found.');
            item.paid = body.paid;
            return item;
        });
        sendJson(response, 200, bill);
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/trials') {
        const body = await readJson(request);
        const trial = {
            id: randomUUID(),
            name: requiredText(body.name, 'Service name'),
            amount: parseAmount(body.amount, 'Monthly charge'),
            expiresOn: validateDate(body.expiresOn, 'Trial end date')
        };
        if (trial.amount <= 0) throw new HttpError(400, 'Monthly charge must be greater than zero.');
        await mutateState((next) => { next.trials.push(trial); });
        sendJson(response, 201, trial);
        return;
    }
    const trialMatch = url.pathname.match(/^\/api\/trials\/([a-z0-9_-]+)$/i);
    if (request.method === 'DELETE' && trialMatch) {
        const removed = await mutateState((next) => {
            const index = next.trials.findIndex((trial) => trial.id === trialMatch[1]);
            if (index === -1) throw new HttpError(404, 'Trial was not found.');
            return next.trials.splice(index, 1)[0];
        });
        sendJson(response, 200, removed);
        return;
    }
    const subscriptionMatch = url.pathname.match(/^\/api\/subscriptions\/([a-z0-9_-]+)$/i);
    if (request.method === 'DELETE' && subscriptionMatch) {
        const id = subscriptionMatch[1];
        await mutateState((next) => {
            const bill = next.bills.find((item) => item.id === id);
            if (!bill) throw new HttpError(404, 'Subscription was not found.');
            if (!next.dismissedSubscriptions.includes(id)) next.dismissedSubscriptions.push(id);
        });
        sendJson(response, 200, { id, dismissed: true });
        return;
    }
    sendError(response, 404, 'API endpoint was not found.');
}

async function serveStatic(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendError(response, 405, 'Method not allowed.');
        return;
    }
    let requestedPath;
    try {
        requestedPath = decodeURIComponent(url.pathname === '/' ? '/elegant_split_login (1).html' : url.pathname);
    } catch {
        sendError(response, 400, 'Invalid URL path.');
        return;
    }
    const filePath = path.resolve(frontendDirectory, `.${requestedPath}`);
    if (!filePath.startsWith(`${frontendDirectory}${path.sep}`)) {
        sendError(response, 403, 'File access denied.');
        return;
    }
    let contents;
    try {
        contents = await fs.readFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
            sendError(response, 404, 'Page was not found.');
            return;
        }
        throw error;
    }
    response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        'Cache-Control': 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
}

async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${host}:${port}`);
    try {
        if (url.pathname.startsWith('/api/')) {
            await handleApi(request, response, url);
            return;
        }
        await serveStatic(request, response, url);
    } catch (error) {
        if (error instanceof HttpError) {
            sendError(response, error.statusCode, error.message);
            return;
        }
        console.error('Request failed:', error);
        if (!response.headersSent) sendError(response, 500, 'The server could not complete the request.');
        else response.destroy();
    }
}

initializeState().then(() => {
    const server = http.createServer(handleRequest);
    server.listen(port, host, () => {
        console.log(`Pennywise backend running at http://${host}:${port}`);
        console.log(`Login: http://${host}:${port}/`);
        console.log(`Dashboard: http://${host}:${port}/command_center.html`);
        console.log(`Persistent data: ${dataFile}`);
    });
    server.on('error', (error) => {
        console.error('Could not start Pennywise backend:', error);
        process.exitCode = 1;
    });
}).catch((error) => {
    console.error('Could not initialize Pennywise data:', error);
    process.exitCode = 1;
});
