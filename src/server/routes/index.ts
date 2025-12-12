import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'

const app = new Hono();

app.get('/', serveStatic({ path: './src/client/index.html' }))
app.get('*', serveStatic({ root: './src/client' }))

export default app;