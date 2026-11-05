// Local-native stand-in for the nginx container (used when Docker is down).
// Serves ../stremio-linux/build + proxies /api/* -> 127.0.0.1:3001 and
// streaming media paths -> 127.0.0.1:11470. Zero deps.
const http = require('node:http');
const https = require('node:https');
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
    const clientHost = req.headers['x-forwarded-host'] || req.headers.host || 'cinemavilla.cc';
    const outboundHeaders = { ...req.headers, host: `127.0.0.1:${targetPort}`, 'x-forwarded-host': clientHost };
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

const metaCache = new Map();
const META_CACHE_TTL_MS = 30 * 60 * 1000;

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&#39;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

const TMDB_DEFAULT_KEY = 'cfe422613b250f702980a3bbf9e90716';

function fetchTmdbMeta(type, tmdbId) {
    const ep = type === 'series' ? 'tv' : 'movie';
    const key = process.env.TMDB_API_KEY || TMDB_DEFAULT_KEY;
    return new Promise((resolve) => {
        const req = https.get(`https://api.themoviedb.org/3/${ep}/${encodeURIComponent(tmdbId)}?api_key=${key}&append_to_response=external_ids`, {
            timeout: 5000,
            headers: { 'Accept': 'application/json' }
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (data && (data.title || data.name)) {
                        const imdbId = (data.external_ids && data.external_ids.imdb_id) || data.imdb_id;
                        const meta = {
                            id: `tmdb:${tmdbId}`,
                            name: data.title || data.name,
                            year: (data.release_date || data.first_air_date || '').slice(0, 4),
                            description: data.overview || '',
                            poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : '',
                            genres: Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [],
                            imdbRating: data.vote_average ? String(data.vote_average) : '',
                            imdb_id: imdbId || ''
                        };
                        return resolve(meta);
                    }
                } catch (_) {}
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function fetchCinemetaMeta(type, id) {
    const key = `${type}:${id}`;
    const cached = metaCache.get(key);
    if (cached && (Date.now() - cached.time < META_CACHE_TTL_MS)) {
        return Promise.resolve(cached.data);
    }
    if (String(id).startsWith('tmdb:')) {
        const numId = String(id).replace(/^tmdb:/, '');
        return fetchTmdbMeta(type, numId).then((meta) => {
            if (meta) {
                metaCache.set(key, { time: Date.now(), data: meta });
                return meta;
            }
            return null;
        });
    }
    const fetchDirect = (t) => new Promise((resolve) => {
        const req = https.get(`https://v3-cinemeta.strem.io/meta/${t}/${encodeURIComponent(id)}.json`, {
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
        }, (upRes) => {
            if (upRes.statusCode !== 200) {
                upRes.resume();
                return resolve(null);
            }
            const chunks = [];
            upRes.on('data', (c) => chunks.push(c));
            upRes.on('end', () => {
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (parsed && parsed.meta) {
                        return resolve(parsed.meta);
                    }
                } catch (_) {}
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });

    return fetchDirect(type).then((meta) => {
        if (meta) {
            metaCache.set(key, { time: Date.now(), data: meta });
            return meta;
        }
        const altType = type === 'movie' ? 'series' : 'movie';
        return fetchDirect(altType).then((fallbackMeta) => {
            if (fallbackMeta) {
                metaCache.set(key, { time: Date.now(), data: fallbackMeta });
                return fallbackMeta;
            }
            return null;
        });
    });
}

async function serveMoviePage(req, res, type, id) {
    const indexPath = path.join(BUILD, 'index.html');
    let html = '';
    try {
        html = fs.readFileSync(indexPath, 'utf8');
    } catch (_) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('Build index.html not found');
    }

    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'cinemavilla.cc';
    let host = String(hostHeader).split(':')[0];
    if (!host || host === '127.0.0.1' || host === 'localhost') {
        host = 'cinemavilla.cc';
    }
    const pageUrl = `https://${host}/${type}/${encodeURIComponent(id)}`;

    const meta = await fetchCinemetaMeta(type, id);
    if (meta) {
        const name = meta.name || id;
        const year = meta.year || meta.releaseInfo || '';
        const overview = meta.description || '';
        const poster = meta.poster || '';
        const genres = Array.isArray(meta.genres) ? meta.genres : [];
        const cast = Array.isArray(meta.cast) ? meta.cast : [];
        const director = Array.isArray(meta.director) ? meta.director : [];
        const siteName = process.env.SITE_NAME || (host.toLowerCase().includes('djmaza') ? 'DJMaza' : 'Cinemavilla');
        const titleStr = `${name} ${year ? `(${year}) ` : ''}- Watch on ${siteName}`;

        html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(titleStr)}</title>`);
        html = html.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${escapeHtml(overview.slice(0, 250))}" />`);
        html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`);
        html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${escapeHtml(titleStr)}" />`);
        html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${escapeHtml(overview.slice(0, 250))}" />`);
        html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`);
        html = html.replace(/<meta\s+property="og:type"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:type" content="${type === 'series' ? 'video.tv_show' : 'video.movie'}" />`);
        if (poster) {
            html = html.replace(/<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:image" content="${escapeHtml(poster)}" />`);
            html = html.replace(/<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/?>/i, `<meta name="twitter:image" content="${escapeHtml(poster)}" />`);
        }
        html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i, `<meta name="twitter:title" content="${escapeHtml(titleStr)}" />`);
        html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i, `<meta name="twitter:description" content="${escapeHtml(overview.slice(0, 250))}" />`);

        const ldJson = JSON.stringify({
            "@context": "https://schema.org",
            "@type": type === 'series' ? "TVSeries" : "Movie",
            "name": name,
            "description": overview,
            "image": poster || undefined,
            "datePublished": String(year || ''),
            "genre": genres,
            "actor": cast.slice(0, 10).map((a) => ({ "@type": "Person", "name": a })),
            "director": director.slice(0, 5).map((d) => ({ "@type": "Person", "name": d })),
            "aggregateRating": rating ? {
                "@type": "AggregateRating",
                "ratingValue": String(rating),
                "bestRating": "10",
                "ratingCount": "1000"
            } : undefined
        });
        html = html.replace(/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/i, `<script type="application/ld+json">\n${ldJson}\n</script>`);

        const prerenderHtml = `
            <div id="seo-prerender" style="display:none;" class="seo-crawler-content">
                <h1>${escapeHtml(name)} ${year ? `(${escapeHtml(year)})` : ''}</h1>
                <p>${escapeHtml(overview)}</p>
                <div class="genres">
                    ${genres.map((g) => `<a href="/#/discover?type=${type}&genre=${encodeURIComponent(g)}">${escapeHtml(g)} Movies</a>`).join(' ')}
                </div>
                <div class="cast">
                    ${cast.slice(0, 10).map((c) => `<a href="/#/search?query=${encodeURIComponent(c)}">${escapeHtml(c)}</a>`).join(' ')}
                </div>
            </div>`;
        html = html.replace('<div id="app"></div>', `<div id="app">${prerenderHtml}</div>`);
    }

    const hydrationScript = `
    <script>
        if (typeof window !== 'undefined' && (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/')) {
            window.location.replace('/#/metadetails/${type}/${encodeURIComponent(id)}');
        }
    </script>`;
    html = html.replace('</head>', `${hydrationScript}\n</head>`);

    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'public, max-age=300'
    });
    res.end(buf);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/') || pathname.startsWith('/brand/')) {
        return proxy(req, res, 3001, '');
    }
    if (pathname === '/sitemap.xml' || pathname === '/sitemap.cml' || pathname === '/sitemap-all.xml' || pathname.startsWith('/sitemaps/')) {
        return proxy(req, res, 3001, '');
    }
    if (pathname === '/robots.txt') {
        const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'cinemavilla.cc';
        let host = String(hostHeader).split(':')[0];
        if (!host || host === '127.0.0.1' || host === 'localhost') host = 'cinemavilla.cc';
        const robots = `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /streaming/\nDisallow: /settings\nDisallow: /network-info\n\nSitemap: https://${host}/sitemap.xml\n`;
        res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=86400'
        });
        return res.end(robots);
    }
    if (pathname.startsWith('/streaming/') || pathname === '/streaming') {
        return proxy(req, res, 11470, '/streaming');
    }
    if (/^\/(hlsv2|hls|mp4|subtitles|subtitleSignature|subtitles\.vtt|opensubHash|settings|network-info|device-info|stats)(\/|\?|$)/.test(pathname)) {
        return proxy(req, res, 11470, '');
    }
    if (/^\/[a-f0-9]{40}\b/i.test(pathname)) {
        let staticFile = path.join(BUILD, decodeURIComponent(pathname));
        try {
            if (fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
                res.writeHead(200, { 'content-type': TYPES[path.extname(staticFile)] || 'application/octet-stream' });
                return fs.createReadStream(staticFile).pipe(res);
            }
        } catch (_) {}
        return proxy(req, res, 11470, '');
    }

    const movieMatch = pathname.match(/^\/(movie|series|metadetails\/movie|metadetails\/series)\/([A-Za-z0-9:_-]+)/i);
    if (movieMatch) {
        const rawType = movieMatch[1].toLowerCase();
        const type = rawType.includes('series') ? 'series' : 'movie';
        const id = movieMatch[2];
        return serveMoviePage(req, res, type, id);
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
