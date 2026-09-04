#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

const DEFAULTS = {
  repo: 'PCT-BR/code-interpreter',
  branch: 'main',
  apiService: 'code-interpreter',
  fileService: 'codeapi-file-server',
  toolService: 'codeapi-tool-call-server',
  minioService: 'codeapi-minio',
  redisService: 'Redis',
  librechatService: 'LibreChat',
  workerId: 'pct-vm',
  baseUrl: 'http://code-interpreter.railway.internal:3112/v1',
};

function usage() {
  console.log(`Usage:
  node scripts/railway-ready.mjs [options]

Options:
  --apply                 Create services and set variables
  --dry-run               Print actions only (default)
  --repo <owner/repo>     GitHub repo to connect new services to
  --branch <branch>       Branch to deploy
  --api-service <name>    Code API service name
  --worker-id <id>        Remote bridge worker ID
  --redis-service <name>  Redis service name (default: Redis)
  --skip-services         Only set variables, do not create services
  --skip-librechat        Do not set LibreChat variables
  --help                  Show this help

This prepares the Railway control plane for remote-bridge mode. The actual
code sandbox still runs on a separate VM/VPS with @librechat/code.`);
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, dryRun: true, createServices: true, setLibreChat: true };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--apply') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--skip-services') {
      args.createServices = false;
    } else if (arg === '--skip-librechat') {
      args.setLibreChat = false;
    } else if (arg === '--repo') {
      args.repo = argv[++i];
    } else if (arg === '--branch') {
      args.branch = argv[++i];
    } else if (arg === '--api-service') {
      args.apiService = argv[++i];
      args.baseUrl = `http://${args.apiService}.railway.internal:3112/v1`;
    } else if (arg === '--worker-id') {
      args.workerId = argv[++i];
    } else if (arg === '--redis-service') {
      args.redisService = argv[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function run(cmd, args, options = {}) {
  const printableArgs = args.map((arg) => {
    if (cmd !== 'railway' || !arg.includes('=')) return arg;
    const key = arg.split('=')[0];
    return `${key}=<set>`;
  });
  const printable = [cmd, ...printableArgs].join(' ');
  if (options.dryRun) {
    console.log(`dry-run: ${printable}`);
    return '';
  }
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
  });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function serviceMap() {
  const raw = capture('railway', ['service', 'list', '--json']);
  const services = JSON.parse(raw);
  return new Map(services.map((service) => [service.name, service]));
}

function ensureService(name, args) {
  const services = serviceMap();
  if (services.has(name)) {
    console.log(`service exists: ${name}`);
    return;
  }
  if (!args.createServices) {
    console.log(`service missing, skipped: ${name}`);
    return;
  }
  run('railway', ['add', '--service', name, '--repo', args.repo, '--branch', args.branch, '--json'], {
    dryRun: args.dryRun,
    capture: true,
  });
  console.log(`service created: ${name}`);
}

function ensureRedis(name, args) {
  const services = serviceMap();
  if (services.has(name)) {
    console.log(`redis exists: ${name}`);
    return;
  }
  if (!args.createServices) {
    console.log(`redis missing, skipped: ${name}`);
    return;
  }
  run('railway', ['add', '--database', 'redis', '--service', name, '--json'], {
    dryRun: args.dryRun,
    capture: true,
  });
  console.log(`redis created: ${name}`);
}

function setVars(service, vars, args) {
  const entries = Object.entries(vars)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  if (entries.length === 0) return;
  run('railway', ['variable', 'set', '--service', service, '--skip-deploys', ...entries], {
    dryRun: args.dryRun,
  });
  console.log(`variables set: ${service} (${entries.map((entry) => entry.split('=')[0]).join(', ')})`);
}

function b64urlSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function jwkMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const kid = `lc-codeapi-${new Date().toISOString().slice(0, 10)}`;
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  return {
    alg: 'EdDSA',
    kid,
    privateJwk: JSON.stringify({ ...privateJwk, kid, alg: 'EdDSA' }),
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'EdDSA' }] }),
  };
}

function manifestMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const railway = spawnSync('railway', ['--version'], { encoding: 'utf8' });
  if (railway.status !== 0) {
    throw new Error('Railway CLI is not available in PATH');
  }

  console.log(args.dryRun ? 'Mode: dry-run' : 'Mode: apply');
  ensureRedis(args.redisService, args);
  ensureService(args.minioService, args);
  ensureService(args.fileService, args);
  ensureService(args.toolService, args);
  ensureService(args.apiService, args);

  const jwt = jwkMaterial();
  const manifest = manifestMaterial();
  const internalToken = b64urlSecret();
  const minioRootUser = `codeapi_${randomBytes(8).toString('hex')}`;
  const minioRootPassword = b64urlSecret();
  const bridgeToken = b64urlSecret();

  const redisVars = {
    REDIS_HOST: `\${{${args.redisService}.REDIS_HOST}}`,
    REDIS_PORT: `\${{${args.redisService}.REDIS_PORT}}`,
    REDIS_PASSWORD: `\${{${args.redisService}.REDIS_PASSWORD}}`,
  };

  setVars(args.minioService, {
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway-minio',
    PORT: '9000',
    MINIO_ROOT_USER: minioRootUser,
    MINIO_ROOT_PASSWORD: minioRootPassword,
  }, args);

  setVars(args.fileService, {
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway-file-server',
    PORT: '3000',
    FILE_SERVER_PORT: '3000',
    MINIO_BUCKET: 'codeapi',
    MINIO_ENDPOINT: `${args.minioService}.railway.internal`,
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: minioRootUser,
    MINIO_SECRET_KEY: minioRootPassword,
    CODEAPI_INTERNAL_SERVICE_TOKEN: internalToken,
    ...redisVars,
  }, args);

  setVars(args.toolService, {
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway-tool-call-server',
    PORT: '3033',
    TOOL_CALL_SERVER_PORT: '3033',
    TOOL_CALL_REQUEST_TIMEOUT: '300000',
    TOOL_CALL_SESSION_EXPIRY: '600',
    CODEAPI_INTERNAL_SERVICE_TOKEN: internalToken,
    ...redisVars,
  }, args);

  setVars(args.apiService, {
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway-api',
    PORT: '3112',
    SERVICE_PORT: '3112',
    LOCAL_MODE: 'false',
    CODEAPI_AUTH_PROVIDER: 'librechat-jwt',
    CODEAPI_JWT_ISSUER: 'librechat',
    CODEAPI_JWT_AUDIENCE: 'codeapi',
    CODEAPI_JWT_ALLOWED_ALGS: jwt.alg,
    CODEAPI_JWT_CLOCK_SKEW_SECONDS: '30',
    CODEAPI_JWT_MAX_TTL_SECONDS: '300',
    CODEAPI_JWT_KEY_CACHE_TTL_SECONDS: '30',
    CODEAPI_JWT_JWKS_JSON: jwt.jwks,
    CODEAPI_JWT_SINGLE_TENANT_ID: 'legacy',
    CODEAPI_SANDBOX_BACKEND: 'remote-bridge',
    CODEAPI_EXECUTION_PROFILE: 'stateful',
    CODEAPI_RUNTIME_SESSION_MODE: 'affinity',
    CODEAPI_BRIDGE_WORKER_ID: args.workerId,
    CODEAPI_BRIDGE_TOKEN: bridgeToken,
    CODEAPI_BRIDGE_AUTH_MODE: 'paired',
    PTC_MODE: 'replay',
    FILE_SERVER_URL: `http://${args.fileService}.railway.internal:3000`,
    TOOL_CALL_SERVER_URL: `http://${args.toolService}.railway.internal:3033`,
    CODEAPI_INTERNAL_SERVICE_TOKEN: internalToken,
    CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY: manifest.privateKey,
    SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: manifest.publicKey,
    ...redisVars,
  }, args);

  if (args.setLibreChat) {
    setVars(args.librechatService, {
      LIBRECHAT_CODE_BASEURL: args.baseUrl,
      CODEAPI_AUTH_PROVIDER: 'librechat-jwt',
      CODEAPI_JWT_ALGORITHM: jwt.alg,
      CODEAPI_JWT_KID: jwt.kid,
      CODEAPI_JWT_ISSUER: 'librechat',
      CODEAPI_JWT_AUDIENCE: 'codeapi',
      CODEAPI_JWT_TTL_SECONDS: '300',
      CODEAPI_JWT_MINT_CACHE_SECONDS: '30',
      CODEAPI_JWT_SINGLE_TENANT_ID: 'legacy',
      CODEAPI_JWT_PRIVATE_JWK_JSON: jwt.privateJwk,
      OPENID_REUSE_TOKENS: 'true',
    }, args);
  }

  console.log('\nNext steps:');
  console.log(`1. Push this repo branch so Railway can see the Dockerfile.railway-* files.`);
  console.log(`2. Redeploy ${args.apiService}, ${args.fileService}, ${args.toolService}, and ${args.minioService}.`);
  console.log(`3. Create a bridge pairing code with Authorization: Bearer <CODEAPI_BRIDGE_TOKEN>.`);
  console.log(`4. Run @librechat/code on the VM/VPS and redeem that pairing code for worker ${args.workerId}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
