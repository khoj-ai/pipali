import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { z } from 'zod';

const app = new OpenAPIHono();

// Define the schemas with names for the OpenAPI spec
const RequestBodySchema = z.object({ message: z.string(), conversationId: z.uuid().optional() }).openapi('ChatRequest');
const ResponseBodySchema = z.object({ response: z.string(), conversationId: z.uuid() }).openapi('ChatResponse');

const route = createRoute({
  method: 'post',
  path: '/chat',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RequestBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ResponseBodySchema,
        },
      },
      description: 'The response from the chat bot.',
    },
  },
});

app.openapi(route, (c) => {
    // This is a dummy handler for documentation purposes.
    // The actual logic is in src/server/routes/openapi.ts
    return c.json({
        response: 'This is a dummy response. Use the real endpoint to interact with the chat bot.',
        conversationId: crypto.randomUUID(),
    });
});

// Generate and serve the OpenAPI document
app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
        version: '1.0.0',
        title: 'Panini API',
    },
});

// The Swagger UI route
app.get(
  '/doc',
  swaggerUI({
    url: '/openapi.json',
  })
);

export default app;
