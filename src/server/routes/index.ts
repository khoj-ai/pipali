import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'
import {
    EMBEDDED_INDEX_HTML,
    EMBEDDED_STYLES_CSS,
    EMBEDDED_APP_JS,
    EMBEDDED_ICONS,
    IS_COMPILED_BINARY,
} from '../embedded-assets';

const app = new Hono();

if (IS_COMPILED_BINARY) {
    // Serve embedded assets from memory
    app.get('/', (c) => {
        return c.html(EMBEDDED_INDEX_HTML);
    });

    app.get('/styles.css', (c) => {
        return c.text(EMBEDDED_STYLES_CSS, 200, {
            'Content-Type': 'text/css',
        });
    });

    app.get('/dist/app.js', (c) => {
        return c.text(EMBEDDED_APP_JS, 200, {
            'Content-Type': 'application/javascript',
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
    // Development mode - serve from disk
    app.get('/', serveStatic({ path: './src/client/index.html' }));
    // Serve public assets (icons, etc.)
    app.get('/icons/*', serveStatic({ root: './src/client/public' }));
    // Serve static files (CSS, JS, etc.)
    app.get('*', serveStatic({ root: './src/client' }));
    // Fallback for SPA routing - serve index.html for any unmatched routes
    app.get('*', async (c) => {
        const html = await Bun.file('./src/client/index.html').text();
        return c.html(html);
    });
}

export default app;