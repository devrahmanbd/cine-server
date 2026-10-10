// Local-native stand-in for the nginx container (used when Docker is down).
// Serves ../stremio-linux/build + proxies /api/* -> 127.0.0.1:3001 and
// streaming media paths -> 127.0.0.1:11470. Zero deps.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = '/Users/rahman/Documents/stremio-linux/build';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };

function proxy(req, res, targetPort, prefix) {
    let targetPath = prefix ? req.url.replace(prefix, '') : req.url;
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
    const proxyReq = http.request(
        { host: '127.0.0.1', port: targetPort, path: targetPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    );
    proxyReq.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream unavailable' }));
    });
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
    if (/^\/(hlsv2|hls|mp4|subtitles)\//.test(pathname)) {
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
