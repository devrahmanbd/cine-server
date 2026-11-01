// Local-native stand-in for the nginx container (used when Docker is down).
// Serves ../stremio-linux/build + proxies /api/* -> 127.0.0.1:3001 and
// streaming media paths -> 127.0.0.1:11470. Zero deps.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = process.env.BUILD_DIR || path.join(__dirname, '..', 'stremio-linux', 'build');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };

function rewriteMediaUrl(rawUrl) {
    if (!rawUrl.includes('mediaURL=') && !rawUrl.includes('videoUrl=')) return rawUrl;
    return rawUrl.replace(/(mediaURL|videoUrl)=([^&]+)/g, (match, paramName, encodedVal) => {
        try {
            let decoded = decodeURIComponent(encodedVal);
            decoded = decoded.replace(/([^:])\/\/+/g, '$1/');
            decoded = decoded.replace(/^https?:\/\/[^/]+\/streaming(\/|$)/i, 'http://127.0.0.1:11470/');
            return `${paramName}=${encodeURIComponent(decoded)}`;
        } catch {
            return match;
        }
    });
}

function proxy(req, res, targetPort, prefix) {
    let targetPath = prefix ? req.url.replace(prefix, '') : req.url;
    targetPath = targetPath.replace(/^\/+/, '/');
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
    targetPath = rewriteMediaUrl(targetPath);
    const isStreaming = targetPort === 11470;
    const FIRST_BYTE_MS = 20000;
    const IDLE_MS = 60000;
    let settled = false;
    let firstByteTimer = null;
    let idleTimer = null;
    const clearTimers = () => {
        if (firstByteTimer) clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        firstByteTimer = null;
        idleTimer = null;
    };
    const fail = () => {
        if (settled || res.writableEnded) return;
        settled = true;
        clearTimers();
        try { proxyReq.destroy(); } catch (_) {}
        try { if (proxyRes) proxyRes.destroy(); } catch (_) {}
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream failed' }));
        } else {
            try { res.destroy(); } catch (_) {}
        }
    };
    let proxyRes = null;
    const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fail, IDLE_MS);
    };
    const outboundHeaders = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const MAX_CHUNK_BYTES = 32 * 1024 * 1024; // 32MB safe chunk limit

    if (isStreaming) {
        const rawRange = outboundHeaders['range'] || outboundHeaders['Range'];
        if (rawRange) {
            const m = String(rawRange).match(/^bytes=(\d+)-(\d+)?$/i);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : undefined;
                if (end === undefined || (end - start + 1) > MAX_CHUNK_BYTES) {
                    const clampedEnd = start + MAX_CHUNK_BYTES - 1;
                    outboundHeaders['range'] = `bytes=${start}-${clampedEnd}`;
                    delete outboundHeaders['Range'];
                }
            }
        } else if (req.method === 'GET' && /^\/[a-f0-9]{40}\/\d+/i.test(targetPath)) {
            outboundHeaders['range'] = `bytes=0-${MAX_CHUNK_BYTES - 1}`;
        }
    }

    const proxyReq = http.request(
        { host: '127.0.0.1', port: targetPort, path: targetPath, method: req.method, headers: outboundHeaders },
        (upRes) => {
            proxyRes = upRes;
            if (firstByteTimer) clearTimeout(firstByteTimer);
            firstByteTimer = null;
            if (isStreaming && upRes.statusCode >= 500) {
                clearTimers();
                try { upRes.destroy(); } catch (_) {}
                fail();
                return;
            }
            if (isStreaming) resetIdle();
            if (targetPath.split('?')[0] === '/settings') {
                const chunks = [];
                upRes.on('data', (chunk) => chunks.push(chunk));
                upRes.on('end', () => {
                    clearTimers();
                    let body = Buffer.concat(chunks).toString('utf8');
                    try {
                        const parsed = JSON.parse(body);
                        const host = req.headers['x-forwarded-host'] || req.headers.host || 'cinemavilla.cc';
                        const proto = req.headers['x-forwarded-proto'] || 'https';
                        parsed.baseUrl = `${proto}://${host}`;
                        body = JSON.stringify(parsed);
                    } catch (_) {}
                    const outHeaders = { ...upRes.headers, 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' };
                    delete outHeaders['transfer-encoding'];
                    res.writeHead(upRes.statusCode, outHeaders);
                    res.end(body);
                });
                return;
            }
            const headers = { ...upRes.headers };
            if (req.method === 'HEAD' && headers['content-length'] && parseInt(headers['content-length'], 10) > MAX_CHUNK_BYTES) {
                delete headers['content-length'];
            }
            res.writeHead(upRes.statusCode, headers);
            if (isStreaming) {
                upRes.on('data', resetIdle);
                upRes.on('end', clearTimers);
            }
            upRes.pipe(res);
            upRes.on('error', fail);
        }
    );
    if (isStreaming) firstByteTimer = setTimeout(fail, FIRST_BYTE_MS);
    proxyReq.on('error', () => {
        if (!settled && !isStreaming) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream unavailable' }));
            return;
        }
        fail();
    });
    proxyReq.on('timeout', fail);
    req.on('aborted', () => { clearTimers(); try { proxyReq.destroy(); } catch (_) {} });
    req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/') || pathname.startsWith('/brand/')) {
        return proxy(req, res, 3001, '');
    }
    if (pathname.startsWith('/streaming/') || pathname === '/streaming') {
        return proxy(req, res, 11470, '/streaming');
    }
    if (/^\/(hlsv2|hls|mp4|subtitles|subtitleSignature|subtitles\.vtt|opensubHash|settings|network-info|device-info|stats)(\/|\?|$)/.test(pathname)) {
        return proxy(req, res, 11470, '');
    }
    if (/^\/[a-f0-9]{40}\b/i.test(pathname)) {
        return proxy(req, res, 11470, '');
    }
    let file = path.join(BUILD, decodeURIComponent(pathname));
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (err, stat) => {
        const serve = !err && stat.isFile() ? file : path.join(BUILD, 'index.html');
        res.writeHead(200, { 'content-type': TYPES[path.extname(serve)] || 'application/octet-stream' });
        fs.createReadStream(serve).pipe(res);
    });
});

server.listen(8080, () => console.log('native web on :8080'));
