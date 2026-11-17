/**
 * Keep the images a conversation carries within what a request can hold.
 *
 * Every request replays the conversation, images included, and one over 32 MiB
 * is rejected before the platform reads it. So an image too large to send
 * several of is left out when its tool returns it, with a note the model can
 * act on by viewing a smaller copy, and each request sends only as many images
 * as fit a budget that leaves room for its text.
 */

import type { ATIFObservationResult, ATIFStep } from './atif/atif.types';

export type ContentItem = Exclude<ATIFObservationResult['content'], string>[number];

/** Max base64 bytes of images in one request, leaving about 9 MB of its 32 MiB for text */
export const MAX_REQUEST_IMAGE_BYTES = 24_000_000;
/** Max base64 bytes of one image, so a request has room for four of the largest */
export const MAX_IMAGE_BYTES = MAX_REQUEST_IMAGE_BYTES / 4;

export const IMAGE_OVER_REQUEST_BUDGET_NOTE = '[Image omitted to keep the request within its size limit.]';

export function isBase64Image(item: ContentItem): boolean {
    return item.type === 'image' && item.source_type === 'base64' && typeof item.data === 'string';
}

/** The item, or for an image too large to send, a note saying so, so the model can view a smaller copy or tell the user */
export function omitOversizedImage(item: ContentItem): ContentItem {
    if (!isBase64Image(item) || item.data!.length <= MAX_IMAGE_BYTES) return item;
    const megabytes = (base64Bytes: number) => ((base64Bytes * 3) / 4 / 1_000_000).toFixed(1);
    return {
        type: 'text',
        text: `[Image omitted: ${megabytes(item.data!.length)} MB is over the ${megabytes(MAX_IMAGE_BYTES)} MB limit for one image. View a smaller copy instead.]`,
    };
}

/**
 * The images to leave out of a request built from these steps, so those sent
 * fit its budget. The oldest go first. Going over budget leaves out enough
 * to halve what is sent, so requests carry the same images, and reuse the
 * prompt cache built on them, until the conversation fills the budget again.
 */
export function imagesOverRequestBudget(steps: ATIFStep[]): Set<ContentItem> {
    const omitted = new Set<ContentItem>();
    const sent: ContentItem[] = [];
    let sentBytes = 0;

    for (const step of steps) {
        for (const result of step.observation?.results ?? []) {
            if (!Array.isArray(result.content)) continue;
            for (const image of result.content.filter(isBase64Image)) {
                sent.push(image);
                sentBytes += image.data!.length;
                if (sentBytes <= MAX_REQUEST_IMAGE_BYTES) continue;
                // The latest image stays unless it alone is over budget
                while (sent.length > 0 && sentBytes > (sent.length > 1 ? MAX_REQUEST_IMAGE_BYTES / 2 : MAX_REQUEST_IMAGE_BYTES)) {
                    const oldest = sent.shift()!;
                    sentBytes -= oldest.data!.length;
                    omitted.add(oldest);
                }
            }
        }
    }
    return omitted;
}
