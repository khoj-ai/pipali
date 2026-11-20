/**
 * Security utilities module.
 *
 * Provides validation and sanitization utilities for:
 * - Sensitive file path detection
 * - Internal/private network URL detection
 */

export { isSensitivePath, getSensitivePathReason } from './path-validator';
export { type ResolvedHost, getInternalAddressReason, resolveHost, fetchResolvedHost } from './url-validator';
