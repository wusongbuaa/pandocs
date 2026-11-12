import { createPandocsDb, createPandocsServices, createIngestWorker, createLocalAssetStore, type AssetStore, type PandocsPorts } from "@pandocs/core";
import { createS3AssetStore } from "@pandocs/core/s3-asset-store";
import type pg from "pg";
import { analyzePoolFromBuild } from "./analyze-pool.js";
import { createEmbedApps } from "./auth/embed.js";
import { createIdentity, userPrincipal } from "./auth/identity.js";
import { createOAuthStore } from "./auth/oauth.js";
import { createPasswordLinks } from "./auth/password-links.js";
import { createLoginFlow } from "./auth/providers.js";
import { createSessionStore } from "./auth/sessions.js";
import { createLoginThrottle } from "./auth/throttle.js";
import { createTokenStore } from "./auth/tokens.js";
import { createUserStore } from "./auth/users.js";
import { onSite, type Config } from "./config.js";
import { createEventHub } from "./events.js";
import { createExtractProcessor, extractorFromConfig } from "./extract/processor.js";
import { createPublicAccess } from "./public-access.js";
import { createLiveCodecPort } from "./live/codec.js";
import { createLiveHub } from "./live/hub.js";
import { createGitPort, gitIsInstalled } from "./git.js";
import { createImporters } from "./importers/index.js";
import { createLlmPort } from "./llm.js";
import { createMailer, createMailNotifier } from "./mail.js";
import { createWebhookSender } from "./webhooks.js";
import { createHostSessions } from "./auth/host-session.js";

function createAssetStore(config: Config): AssetStore & { destroy?(): void } {
  const { storage } = config;
  if (storage.kind === "local") return createLocalAssetStore(storage.dir);
  return createS3AssetStore({ bucket: storage.bucket, region: storage.region, prefix: storage.prefix, endpoint: storage.endpoint, forcePathStyle: storage.forcePathStyle });
}

export function createRuntime(config: Config & { readonly secret: string }, pool: pg.Pool, overrides: Partial<PandocsPorts> = {}) {
  const users = createUserStore(pool);
  const sessions = createSessionStore(pool);
  const tokens = createTokenStore(pool);
  const throttle = createLoginThrottle(pool);
  const embedApps = createEmbedApps(pool, config.secret);
  const oauth = createOAuthStore(pool, tokens);
  const hostSessions = config.hostSession ? createHostSessions(config.hostSession, { users }) : undefined;
  const identity = createIdentity({ config, sessions, tokens, embedApps, shareLink: token => services.shareLinks.principalOf(token), hostSessions });
  const assets = createAssetStore(config);
  const analyzePool = analyzePoolFromBuild();
  const extractor = extractorFromConfig(config.extract);
  const liveCodec = config.liveEditing ? createLiveCodecPort() : null;
  const services = createPandocsServices({
    db: createPandocsDb(pool),
    ports: {
      assets,
      ...(analyzePool ? { analyze: analyzePool.analyze } : {}),
      ...(config.publicSpaces ? {} : { publicSpacesDisabled: true }),
      ...(config.readingStats ? {} : { statsDisabled: true }),
      ...(extractor ? { processors: [createExtractProcessor(extractor)] } : {}),
      directory: {
        search: (query, limit) => users.search(query, limit),
        names: ids => users.names(ids),
        principal: async id => {
          const user = await users.findById(id);
          return user?.status === "active" ? userPrincipal(user, ["read"], "web") : null;
        }
      },
      ...(config.llm ? { llm: createLlmPort(config.llm, pool) } : {}),
      importers: createImporters(config.feishu),
      ...(gitIsInstalled() ? { git: createGitPort({ allowPrivate: config.gitAllowPrivate }) } : {}),
      ...(liveCodec ? { liveCodec } : {}),
      webhookSender: createWebhookSender({ publicUrl: config.publicUrl, allowPrivate: config.webhooksAllowPrivate }),
      ...(config.smtp ? { notifier: createMailNotifier({ smtp: config.smtp, publicUrl: config.publicUrl, users }) } : {}),
      passwordLogin: config.passwordLogin,
      siteDefaults: { title: config.siteTitle ?? "Pandocs", logoutUrl: config.hostSession?.logoutUrl ?? `${config.basePath}/logout` },
      ...overrides
    }
  });
  const passwordLinks = createPasswordLinks({ pool, publicUrl: config.publicUrl, enabled: config.passwordLogin, mail: config.smtp ? createMailer(config.smtp, config.publicUrl) : null, siteTitle: async () => (await services.site.get()).title });
  const flows = config.providers.map(provider => createLoginFlow(provider, onSite(config.publicUrl, `/auth/${provider.id}/callback`), config.secret));
  const worker = createIngestWorker(services);
  const events = createEventHub({ identity, services });
  const publicAccess = createPublicAccess({ services, enabled: config.publicSpaces });
  const live = createLiveHub({
    services,
    authenticate: request => identity.authenticate(request),
    publicOrigin: config.publicUrl.origin,
    basePath: config.basePath,
    listenUrl: config.databaseListenUrl,
    publish: (channel, payload) => pool.query("SELECT pg_notify($1, $2)", [channel, payload]),
    recheckMs: config.liveRecheckMs
  });
  const stopping: (() => void)[] = [];
  return {
    events,
    live,
    publicAccess,
    lifecycle: { draining: false },
    embedApps,
    oauth,
    config,
    pool,
    users,
    sessions,
    tokens,
    throttle,
    passwordLinks,
    identity,
    hostSessions,
    services,
    flows,
    worker,
    onDestroy(stop: () => void) {
      stopping.push(stop);
    },
    destroy() {
      for (const stop of stopping) stop();
      void services.stats.flush();
      events.stop();
      worker.stop();
      void analyzePool?.stop();
      void liveCodec?.stop();
      assets.destroy?.();
    }
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
