import { z } from 'zod';

export const DiagnosticLevelSchema = z.enum(['info', 'warn', 'error']);
export const DiagnosticDetailsSchema = z.object({
  operation: z.enum(['proxy', 'recovery', 'discovery']).optional(),
  domain: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/).optional(),
  status: z.number().int().min(0).max(599).optional(),
  durationMs: z.number().int().min(0).max(3600000).optional(),
  reason: z.enum(['http_status', 'too_large', 'content_type', 'invalid_image', 'network_or_timeout', 'unsafe_redirect', 'redirect_limit', 'unavailable', 'unexpected', 'capacity', 'not_on_page']).optional(),
  available: z.boolean().optional(),
  cached: z.boolean().optional(),
  offers: z.number().int().min(0).max(10000).optional(),
  relatedTraceId: z.uuid().optional(),
  errorType: z.enum(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'UnknownError']).optional(),
  asset: z.string().max(150).regex(/^\/assets\/[\w.-]+\.js$/).optional(),
  line: z.number().int().min(0).max(10000000).optional(),
  column: z.number().int().min(0).max(10000000).optional(),
}).strict();
export const DiagnosticKindSchema = z.enum([
  'image.request.started', 'image.request.completed', 'image.fetch.completed', 'image.fetch.unavailable', 'image.fetch.shared', 'image.fallback.started',
  'image.page.completed', 'image.page.unavailable', 'image.page.no_candidates', 'image.product.resolved', 'image.recovery.shared',
  'client.image_unavailable', 'client.runtime_error', 'client.unhandled_rejection',
  'offer.verification.confirmed', 'offer.verification.corrected', 'offer.verification.unconfirmed',
]);
export const DiagnosticScopeSchema = z.object({
  traceId: z.uuid(), source: z.enum(['browser', 'server']),
  sessionId: z.uuid().nullable().default(null), roundId: z.uuid().nullable().default(null),
  productId: z.string().min(1).max(100).regex(/^[\w-]+$/).nullable().default(null),
}).strict();
export const DiagnosticInputSchema = DiagnosticScopeSchema.extend({
  event: DiagnosticKindSchema, level: DiagnosticLevelSchema, details: DiagnosticDetailsSchema,
}).strict();
export const ClientEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image_unavailable'), traceId: z.uuid().optional(),
    sessionId: z.uuid(), productId: z.string().min(1).max(100).regex(/^[\w-]+$/),
  }).strict(),
  z.object({
    kind: z.enum(['runtime_error', 'unhandled_rejection']), traceId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    errorType: DiagnosticDetailsSchema.shape.errorType.unwrap(),
    asset: DiagnosticDetailsSchema.shape.asset, line: DiagnosticDetailsSchema.shape.line, column: DiagnosticDetailsSchema.shape.column,
  }).strict(),
]);
export const DiagnosticQuerySchema = z.object({
  traceId: z.uuid().optional(), sessionId: z.uuid().optional(),
  source: z.enum(['browser', 'server']).optional(), level: DiagnosticLevelSchema.optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict();
export type DiagnosticDetails = z.infer<typeof DiagnosticDetailsSchema>;
export type DiagnosticScope = z.infer<typeof DiagnosticScopeSchema>;
export type DiagnosticInput = z.infer<typeof DiagnosticInputSchema>;
export type DiagnosticQuery = z.infer<typeof DiagnosticQuerySchema>;
export type DiagnosticEvent = DiagnosticInput & { id: string; createdAt: string };
export type ClientEvent = z.infer<typeof ClientEventSchema>;
