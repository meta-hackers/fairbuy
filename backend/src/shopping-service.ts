import { randomUUID } from 'node:crypto';
import {
  EMPTY_CONFIG, activeProducts, allProducts, constraintsFor, effectiveConfig, isConfigReady, latestRound, rankOffers,
  type DiscoveryContext, type ShoppingConfig, type ShoppingSession,
} from '@fairbuy/core';
import type { AIProvider } from './ai/provider';
import type { Store, Job } from './store';
import { AppError, publicError } from './errors';

export class ShoppingService {
  constructor(readonly store: Store, readonly ai: AIProvider, readonly mode: 'live' | 'demo') {}
  async create(owner: string) {
    const now = new Date().toISOString();
    const session: ShoppingSession = {
      id: randomUUID(), version: 0, mode: this.mode, createdAt: now, updatedAt: now, stage: 'ask',
      askSessionId: randomUUID(), configureSessionId: randomUUID(), askMessages: [], configureMessages: [],
      config: structuredClone(EMPTY_CONFIG), initialConfig: null, ready: false, missing: [], feedback: [], rounds: [], selectedProductId: null,
    };
    await this.store.create(owner, session); return session;
  }
  private idle(session: ShoppingSession) {
    if (session.mode !== this.mode) throw new AppError(409, 'This search belongs to a different deployment mode. Start a new search.');
    if (['queued', 'running'].includes(latestRound(session)?.status ?? '')) throw new AppError(409, 'A search is already running. Wait for it to finish before making changes.', 'SEARCH_BUSY');
  }
  private context(session: ShoppingSession, discoverySessionId = 'feedback-interpretation'): DiscoveryContext {
    const previousProducts = allProducts(session);
    const discardedIds = new Set(session.feedback.map(f => f.productId));
    return structuredClone({
      sessionId: session.id, discoverySessionId, initialRequest: session.askMessages.find(m => m.role === 'user')?.content ?? '',
      initialConfig: session.initialConfig ?? session.config, config: session.config, previousProducts,
      discardedProducts: previousProducts.filter(p => discardedIds.has(p.id)), feedback: session.feedback,
    });
  }
  private queue(session: ShoppingSession, trigger: 'configure' | 'learn' | 'refresh') {
    this.idle(session);
    if (session.rounds.length >= 12) throw new AppError(429, 'This search has reached its 12-round limit. Start a new search.');
    if (!isConfigReady(session.config)) throw new AppError(400, 'Set a product category, intended use and country before searching.');
    if (!session.initialConfig) session.initialConfig = structuredClone(session.config);
    const id = randomUUID();
    session.rounds.push({
      id, number: session.rounds.length + 1, attempt: 0, trigger, status: 'queued',
      createdAt: new Date().toISOString(), finishedAt: null, products: [], sources: [], summary: '', error: null,
      context: this.context(session, id), ranking: null,
    });
    session.stage = 'discovery'; session.selectedProductId = null;
  }
  async message(id: string, owner: string, phase: 'ask' | 'configure', message: string) {
    this.ai.ensureConfigured();
    return this.store.mutate(id, owner, async session => {
      this.idle(session);
      if (phase === 'configure' && !session.ready) throw new AppError(409, 'Finish the Ask conversation first.');
      const messages = phase === 'ask' ? session.askMessages : session.configureMessages;
      if (messages.length >= 40) throw new AppError(429, 'Conversation limit reached. Review the configuration or start a new search.');
      // Stage changes, messages and config commit atomically only after validation.
      const result = await this.ai.converse(phase, [...messages, { role: 'user', content: message }], session.config);
      messages.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply });
      session.config = result.config;
      session.ready = isConfigReady(result.config) && (phase === 'configure' || result.ready);
      session.missing = result.missing; session.selectedProductId = null;
      session.stage = phase;
    });
  }
  async configure(id: string, owner: string, config: ShoppingConfig) {
    return this.store.mutate(id, owner, session => {
      this.idle(session);
      if (!session.ready) throw new AppError(409, 'Finish Ask before editing the configuration.');
      session.config = config; session.stage = 'configure'; session.selectedProductId = null;
    });
  }
  async discover(id: string, owner: string) {
    this.ai.ensureConfigured();
    return this.store.mutate(id, owner, session => {
      if (session.mode !== this.mode) throw new AppError(409, 'Start a new search after changing the deployment mode.');
      if (!session.ready) throw new AppError(409, 'Finish Ask and review Configure before searching.');
      const last = latestRound(session);
      // An accidental double click/retry while queued/running is idempotent.
      if (last && ['queued', 'running'].includes(last.status)) return;
      this.queue(session, session.rounds.length ? 'refresh' : 'configure');
    });
  }
  async learn(id: string, owner: string, input: { productId: string | null; reason: string }) {
    this.ai.ensureConfigured();
    return this.store.mutate(id, owner, async session => {
      this.idle(session);
      if (!session.rounds.length) throw new AppError(409, 'Discover some products before adding feedback.');
      if (session.feedback.length >= 30 || session.rounds.length >= 12) throw new AppError(429, 'Feedback limit reached. Start a new search.');
      const product = input.productId ? activeProducts(session).find(p => p.id === input.productId) : null;
      if (input.productId && !product) throw new AppError(400, 'Choose a product from the current shortlist.');
      const learned = await this.ai.learn(this.context(session), input.reason, product ?? null);
      const feedback = { id: randomUUID(), productId: product?.id ?? null, productName: product?.name ?? null, reason: input.reason, at: new Date().toISOString(), learned: learned.requirements };
      session.feedback.push(feedback);
      // Learned requirements are separate from editable base config: removing feedback is lossless.
      this.queue(session, 'learn');
    });
  }
  async undo(id: string, owner: string, feedbackId: string) {
    this.ai.ensureConfigured();
    return this.store.mutate(id, owner, session => {
      this.idle(session);
      if (!session.feedback.some(f => f.id === feedbackId)) throw new AppError(404, 'Feedback not found.');
      if (session.rounds.length >= 12) throw new AppError(429, 'Round limit reached. Start a new search.');
      session.feedback = session.feedback.filter(f => f.id !== feedbackId);
      this.queue(session, 'learn');
    });
  }
  async select(id: string, owner: string, productId: string) {
    return this.store.mutate(id, owner, session => {
      this.idle(session);
      if (JSON.stringify(latestRound(session)?.context.config) !== JSON.stringify(session.config)) throw new AppError(409, 'Your brief changed. Refresh discovery before choosing a product.');
      if (!activeProducts(session).some(p => p.id === productId && p.offers.some(o => latestRound(session)?.ranking?.ranked.some(r => r.offerId === o.id)))) throw new AppError(400, 'This product is not eligible in the current shortlist.');
      session.selectedProductId = productId; session.stage = 'buy';
    });
  }
  async navigate(id: string, owner: string, stage: ShoppingSession['stage']) {
    return this.store.mutate(id, owner, session => {
      this.idle(session);
      if (stage === 'configure' && !session.ready) throw new AppError(409, 'Finish Ask first.');
      if (stage === 'discovery' && !session.rounds.length) throw new AppError(409, 'Start a discovery search first.');
      if (stage === 'buy' && (!session.selectedProductId || !activeProducts(session).some(p => p.id === session.selectedProductId))) throw new AppError(409, 'Choose a product first.');
      session.stage = stage;
    });
  }
  async runJob(job: Job) {
    try {
      let context: DiscoveryContext | null = null;
      await this.store.mutate(job.sessionId, null, session => {
        const round = session.rounds.find(r => r.id === job.id);
        if (!round || !['queued', 'running'].includes(round.status)) return;
        if (session.mode !== this.mode || job.attempts > 2) {
          round.status = 'failed'; round.finishedAt = new Date().toISOString();
          round.error = session.mode !== this.mode ? 'Deployment mode changed. Start a new search.' : 'Search interrupted twice. Please retry.'; return;
        }
        round.status = 'running'; round.attempt = job.attempts; context = round.context;
      });
      if (!context) { await this.store.finish(job); return; }
      const result = await this.ai.discover(context);
      await this.store.mutate(job.sessionId, null, session => {
        const round = session.rounds.find(r => r.id === job.id);
        if (!round || round.status !== 'running' || round.attempt !== job.attempts) return;
        const discarded = new Set(round.context.discardedProducts.map(p => p.id));
        round.products = result.products.filter(p => !discarded.has(p.id));
        round.sources = result.sources; round.summary = result.summary;
        const effective = effectiveConfig(round.context);
        round.ranking = rankOffers({
          offers: round.products.flatMap(p => p.offers), constraints: constraintsFor(effective), currency: effective.currency,
          spec: { id: effective.category ?? 'products', attributes: effective.requirements.filter(r => r.attribute).map(r => ({ key: r.attribute!, unit: r.unit ?? undefined })) },
        });
        round.status = 'complete'; round.finishedAt = new Date().toISOString();
      });
    } catch (error) {
      try {
        await this.store.mutate(job.sessionId, null, session => {
          const round = session.rounds.find(r => r.id === job.id);
          if (round && round.attempt === job.attempts && ['queued', 'running'].includes(round.status)) { round.status = 'failed'; round.error = publicError(error); round.finishedAt = new Date().toISOString(); }
        });
      } catch (saveError) {
        if (!(saveError instanceof AppError && saveError.status === 404)) throw saveError; // lease recovery on database outage
      }
    }
    await this.store.finish(job);
  }
}
