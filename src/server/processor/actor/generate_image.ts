/**
 * Image Generation Actor Tool
 *
 * Generates images from text prompts using the Pipali Platform's image generation service.
 * Saves the generated image to disk and returns it as multimodal content.
 */

import { platformFetch } from '../../http/platform-fetch';
import { getPlatformUrl } from '../../auth';
import { createChildLogger } from '../../logger';
import { join } from 'path';
import { mkdir } from 'fs/promises';

const log = createChildLogger({ component: 'generate_image' });

const IMAGE_GEN_TIMEOUT = 60000;
const IMAGES_DIR = '/tmp/pipali/images';

export interface GenerateImageArgs {
    prompt: string;
    aspect_ratio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}

interface GenerateImageResult {
    compiled: string | Array<{ type: string; [key: string]: any }>;
}

interface PlatformImageResponse {
    image_base64: string;
    mime_type: string;
}

/** Map mime type to file extension */
function mimeToExt(mime: string): string {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
    };
    return map[mime] || 'png';
}

export async function generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
    const { prompt, aspect_ratio } = args;

    if (!prompt?.trim()) {
        return { compiled: 'Error: prompt is required for image generation.' };
    }

    const platformUrl = getPlatformUrl();
    const endpoint = `${platformUrl}/tools/generate-image`;

    log.debug(`Generating image for prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

    try {
        const result = await platformFetch<PlatformImageResponse>(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, aspect_ratio }),
            timeout: IMAGE_GEN_TIMEOUT,
        });

        if (result.wasRetried) {
            log.debug('Platform image generation succeeded after token refresh');
        }

        const { image_base64, mime_type } = result.data;

        if (!image_base64) {
            return { compiled: 'Error: No image was generated. The service returned an empty response.' };
        }

        // Save image to disk
        const ext = mimeToExt(mime_type);
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = join(IMAGES_DIR, filename);

        try {
            await mkdir(IMAGES_DIR, { recursive: true });
            await Bun.write(filePath, Buffer.from(image_base64, 'base64'));
            log.debug(`Saved generated image to ${filePath}`);
        } catch (saveError) {
            log.warn({ err: saveError }, 'Failed to save generated image to disk, returning inline only');
        }

        // Return in the same multimodal format as view_file and MCP tools
        return {
            compiled: [
                {
                    type: 'text',
                    text: `Generated image saved to: ${filePath}`,
                },
                {
                    type: 'image',
                    source_type: 'base64',
                    mime_type,
                    data: image_base64,
                },
            ],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, 'Image generation failed');
        return { compiled: `Error generating image: ${message}` };
    }
}
