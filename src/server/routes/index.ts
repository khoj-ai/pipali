import path from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'
import {
    EMBEDDED_INDEX_HTML,
    EMBEDDED_STYLES_CSS,
    EMBEDDED_APP_JS,
    EMBEDDED_SERVICE_WORKER,
    EMBEDDED_MANIFEST,
    EMBEDDED_ICONS,
    IS_COMPILED_BINARY,
} from '../embedded-assets';

const app = new Hono();

if (IS_COMPILED_BINARY) {
    // Serve embedded assets from memory
    app.get('/', (c) => {
        return c.html(EMBEDDED_INDEX_HTML);
    });

    app.get('/styles/index.css', (c) => {
        return c.text(EMBEDDED_STYLES_CSS, 200, {
            'Content-Type': 'text/css',
        });
    });

    app.get('/dist/app.js', (c) => {
        return c.text(EMBEDDED_APP_JS, 200, {
            'Content-Type': 'application/javascript',
        });
    });

    app.get('/sw.js', (c) => {
        return c.text(EMBEDDED_SERVICE_WORKER, 200, {
            'Content-Type': 'application/javascript',
            // The worker is the push receiver; a stale cached copy silently stops delivery.
            'Cache-Control': 'no-cache',
        });
    });

    app.get('/manifest.webmanifest', (c) => {
        return c.text(EMBEDDED_MANIFEST, 200, {
            'Content-Type': 'application/manifest+json',
        });
    });

    // Serve embedded icons
    app.get('/icons/:filename', (c) => {
        const filename = c.req.param('filename');
        const iconData = EMBEDDED_ICONS[filename];
        if (iconData) {
            const buffer = Buffer.from(iconData, 'base64');
            return c.body(buffer, 200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=31536000',
            });
        }
        return c.notFound();
    });

    // Fallback for any other routes - serve index.html for SPA routing
    app.get('*', (c) => {
        return c.html(EMBEDDED_INDEX_HTML);
    });
} else {
    const clientRoot = process.env.PIPALI_SERVER_RESOURCE_DIR
        ? path.join(process.env.PIPALI_SERVER_RESOURCE_DIR, 'src', 'client')
        : './src/client';
    // Development mode - serve from disk
    app.get('/', serveStatic({ path: path.join(clientRoot, 'index.html') }));

    const serveClientFile = (route: string, file: string, contentType: string) => {
        app.get(route, async (c) => {
            const source = Bun.file(path.join(clientRoot, file));
            if (!(await source.exists())) return c.notFound();
            return c.text(await source.text(), 200, {
                'Content-Type': contentType,
                // The worker is the push receiver; a stale cached copy silently stops delivery.
                'Cache-Control': 'no-cache',
            });
        });
    };

    serveClientFile('/sw.js', 'sw.js', 'application/javascript');
    serveClientFile('/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json');

    // Serve public assets (icons, etc.)
    app.get('/icons/*', serveStatic({ root: path.join(clientRoot, 'public') }));
    // Serve static files (CSS, JS, etc.)
    app.get('*', serveStatic({ root: clientRoot }));
    // Fallback for SPA routing - serve index.html for any unmatched routes
    app.get('*', async (c) => {
        const html = await Bun.file(path.join(clientRoot, 'index.html')).text();
        return c.html(html);
    });
}

export default app;