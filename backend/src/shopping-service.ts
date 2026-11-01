import { randomUUID } from 'node:crypto';
import {
  EMPTY_CONFIG, activeProducts, allProducts, isConfigReady, latestRound, rankProducts,
  type DiscoveryContext, type ShoppingConfig, type ShoppingLocation, type ShoppingSession,
} from '@fairbuy/core';
import { mergeDiscoveryResults, type AIProvider, type DiscoveryResult } from './ai/provider';
import type { Store, Job } from './store';
import { AppError, publicError } from './errors';
import { logger } from './logger';
import { UsageStore } from './usage';

export class ShoppingService {
  constructor(readonly store: Store, readonly ai: AIProvider, readonly mode: 'live' | 'demo', readonly usage = new UsageStore()) {}
  async create(owner: string, location?: ShoppingLocation) {
    const now = new Date().toISOString();
    const session: ShoppingSession = {
      id: randomUUID(), version: 0, mode: this.mode, createdAt: now, updatedAt: now, stage: 'ask',
      askSessionId: randomUUID(), configureSessionId: randomUUID(), askMessages: [], configureMessages: [],
      config: structuredClone(EMPTY_CONFIG), initialConfig: null, ready: false, missing: [], feedback: [], rounds: [], selectedProductId: null,
    };
    if (location) session.config = { ...session.config, ...location, currency: location.currency ?? session.config.currency };
    await this.store.create(owner, session);
    logger.info('session.created', { sessionId: session.id, mode: this.mode, country: session.config.country, currency: session.config.currency });
    return session;
  }
  async locate(id: string, owner: string, location: ShoppingLocation, onlyIfMissing = false) {
    const session = await this.store.mutate(id, owner, session => {
      this.idle(session);
      if (onlyIfMissing && session.config.country) return;
      session.config = { ...session.config, ...location, currency: location.currency ?? session.config.currency };
      session.selectedProductId = null;
      if (session.stage === 'buy') session.stage = 'configure';
    });
    logger.info('session.location.updated', { sessionId: id, country: location.country, currency: location.currency, onlyIfMissing });
    return session;
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
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, durationMs: null,
      products: [], sources: [], summary: '', error: null,
      context: this.context(session, id), ranking: null,
    });
    session.stage = 'discovery'; session.selectedProductId = null;
    logger.info('discovery.round.queued', {
      sessionId: session.id, roundId: id, round: session.rounds.length, trigger,
      previousProducts: session.rounds.at(-1)?.context.previousProducts.length ?? 0,
      feedback: session.feedback.length,
    });
  }
  async message(id: string, owner: string, phase: 'ask' | 'configure', message: string) {
    return this.usage.capture(id, phase, null, () => this.messageWithUsage(id, owner, phase, message));
  }
  private async messageWithUsage(id: string, owner: string, phase: 'ask' | 'configure', message: string) {
    this.ai.ensureConfigured();
    const started = Date.now();
    const session = await this.store.mutate(id, owner, async session => {
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
    logger.info('session.message.completed', { sessionId: id, phase, durationMs: Date.now() - started, messages: phase === 'ask' ? session.askMessages.length : session.configureMessages.length, ready: session.ready });
    return session;
  }
  async configure(id: string, owner: string, config: ShoppingConfig) {
    const session = await this.store.mutate(id, owner, session => {
      this.idle(session);
      if (!session.ready) throw new AppError(409, 'Finish Ask before editing the configuration.');
      session.config = config; session.stage = 'configure'; session.selectedProductId = null;
    });
    logger.info('session.configure.saved', { sessionId: id, requirements: config.requirements.length, budgetMax: config.budgetMax, country: config.country, currency: config.currency });
    return session;
  }
  async discover(id: string, owner: string) {
    this.ai.ensureConfigured();
    const session = await this.store.mutate(id, owner, session => {
      if (session.mode !== this.mode) throw new AppError(409, 'Start a new search after changing the deployment mode.');
      if (!session.ready) throw new AppError(409, 'Finish Ask and review Configure before searching.');
      const last = latestRound(session);
      // An accidental double click/retry while queued/running is idempotent.
      if (last && ['queued', 'running'].includes(last.status)) return;
      this.queue(session, session.rounds.length ? 'refresh' : 'configure');
    });
    logger.info('discovery.request.accepted', { sessionId: id, round: latestRound(session)?.number, status: latestRound(session)?.status });
    return session;
  }
  async learn(id: string, owner: string, input: { productId: string | null; reason: string }) {
    return this.usage.capture(id, 'learn', null, () => this.learnWithUsage(id, owner, input));
  }
  private async learnWithUsage(id: string, owner: string, input: { productId: string | null; reason: string }) {
    this.ai.ensureConfigured();
    const started = Date.now();
    const session = await this.store.mutate(id, owner, async session => {
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
    logger.info('session.feedback.learned', { sessionId: id, durationMs: Date.now() - started, productId: input.productId, learnedRequirements: session.feedback.at(-1)?.learned.length ?? 0 });
    return session;
  }
  async undo(id: string, owner: string, feedbackId: string) {
    this.ai.ensureConfigured();
    const session = await this.store.mutate(id, owner, session => {
      this.idle(session);
      if (!session.feedback.some(f => f.id === feedbackId)) throw new AppError(404, 'Feedback not found.');
      if (session.rounds.length >= 12) throw new AppError(429, 'Round limit reached. Start a new search.');
      session.feedback = session.feedback.filter(f => f.id !== feedbackId);
      this.queue(session, 'learn');
    });
    logger.info('session.feedback.removed', { sessionId: id, feedbackId });
    return session;
  }
  async select(id: string, owner: string, productId: string) {
    const session = await this.store.mutate(id, owner, session => {
      this.idle(session);
      if (JSON.stringify(latestRound(session)?.context.config) !== JSON.stringify(session.config)) throw new AppError(409, 'Your brief changed. Refresh discovery before choosing a product.');
      if (!activeProducts(session).some(p => p.id === productId && p.offers.some(o => latestRound(session)?.ranking?.ranked.some(r => r.offerId === o.id)))) throw new AppError(400, 'This product is not eligible in the current shortlist.');
      session.selectedProductId = productId; session.stage = 'buy';
    });
    logger.info('session.product.selected', { sessionId: id, productId });
    return session;
  }
  async navigate(id: string, owner: string, stage: ShoppingSession['stage']) {
    const session = await this.store.mutate(id, owner, session => {
      this.idle(session);
      if (stage === 'configure' && !session.ready) throw new AppError(409, 'Finish Ask first.');
      if (stage === 'discovery' && !session.rounds.length) throw new AppError(409, 'Start a discovery search first.');
      if (stage === 'buy' && (!session.selectedProductId || !activeProducts(session).some(p => p.id === session.selectedProductId))) throw new AppError(409, 'Choose a product first.');
      session.stage = stage;
    });
    logger.info('session.stage.changed', { sessionId: id, stage });
    return session;
  }
  async runJob(job: Job) {
    return this.usage.capture(job.sessionId, 'discovery', job.id, () => this.runJobWithUsage(job));
  }
  private async runJobWithUsage(job: Job) {
    const jobStarted = Date.now();
    let context: DiscoveryContext | null = null;
    let startedAt: string | null = null;
    try {
      await this.store.mutate(job.sessionId, null, session => {
        const round = session.rounds.find(r => r.id === job.id);
        if (!round || !['queued', 'running'].includes(round.status) || round.attempt > job.attempts) return;
        if (session.mode !== this.mode || job.attempts > 2) {
          this.finishRound(round, 'failed', session.mode !== this.mode ? 'Deployment mode changed. Start a new search.' : 'Search interrupted twice. Please retry.');
          return;
        }
        round.status = 'running'; round.attempt = job.attempts;
        round.startedAt ??= new Date().toISOString();
        startedAt = round.startedAt;
        context = round.context;
      });
      if (!context) { await this.store.finish(job); logger.info('discovery.job.skipped', { sessionId: job.sessionId, roundId: job.id, attempts: job.attempts }); return; }
      const activeContext = context as DiscoveryContext;
      logger.info('discovery.job.started', {
        sessionId: job.sessionId, roundId: job.id, attempt: job.attempts, startedAt,
        previousProducts: activeContext.previousProducts.length, discardedProducts: activeContext.discardedProducts.length, feedback: activeContext.feedback.length,
      });
      const save = async (result: DiscoveryResult, complete = false) => {
        const saveStarted = Date.now();
        await this.store.mutate(job.sessionId, null, session => {
          const round = session.rounds.find(r => r.id === job.id);
          if (!round || round.status !== 'running' || round.attempt !== job.attempts) return;
          const discarded = new Set(round.context.discardedProducts.map(p => p.id));
          const merged = mergeDiscoveryResults(round, result);
          round.products = merged.products.filter(p => !discarded.has(p.id));
          round.sources = merged.sources; round.summary = merged.summary;
          round.ranking = rankProducts(round.products, round.context);
          if (complete) this.finishRound(round, 'complete');
        });
        logger.info('discovery.progress.saved', {
          sessionId: job.sessionId, roundId: job.id, complete, durationMs: Date.now() - saveStarted,
          products: result.products.length, sources: result.sources.length,
        });
      };
      const result = await this.ai.discover(activeContext, save);
      await save(result, true);
      logger.info('discovery.job.completed', { sessionId: job.sessionId, roundId: job.id, durationMs: Date.now() - jobStarted, products: result.products.length, sources: result.sources.length });
    } catch (error) {
      logger.error('discovery.job.failed', {
        sessionId: job.sessionId, roundId: job.id, attempt: job.attempts, durationMs: Date.now() - jobStarted,
        code: error instanceof AppError ? error.code : 'UNEXPECTED', message: publicError(error),
      });
      try {
        await this.store.mutate(job.sessionId, null, session => {
          const round = session.rounds.find(r => r.id === job.id);
          if (round && round.attempt === job.attempts && ['queued', 'running'].includes(round.status)) this.finishRound(round, 'failed', publicError(error));
        });
      } catch (saveError) {
        if (!(saveError instanceof AppError && saveError.status === 404)) throw saveError; // lease recovery on database outage
      }
    }
    await this.store.finish(job);
  }
  private finishRound(round: ShoppingSession['rounds'][number], status: 'complete' | 'failed', error: string | null = null) {
    const now = new Date();
    round.status = status; round.error = error; round.finishedAt = now.toISOString();
    const from = round.startedAt ?? round.createdAt;
    round.durationMs = Math.max(0, now.getTime() - new Date(from).getTime());
  }
}
